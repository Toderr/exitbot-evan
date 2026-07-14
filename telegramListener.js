/**
 * Telegram command listener — long-polls getUpdates for plain-text commands
 * and inline-keyboard button taps. Only the configured TELEGRAM_CHAT_ID is
 * honored; messages/taps from other chats are ignored (this bot signs
 * transactions, so it must not act on strangers).
 */
import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { config } from "./config.js";
import bot from "./telegram.js";
import {
  scanOnChain,
  adoptCandidate,
  getPendingCandidate,
  listPending,
  listManaged,
  statusText,
  setEnabled,
  forget,
  setAwaitingCustom,
  getAwaitingCustom,
  clearAwaitingCustom,
} from "./manager.js";

const OFFSET_FILE = "./state/telegram-offset.json";

function loadOffset() {
  try { return JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8"))?.offset ?? 0; }
  catch { return 0; }
}
function saveOffset(offset) {
  fs.mkdirSync(path.dirname(OFFSET_FILE), { recursive: true });
  fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }));
}

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

const HELP_TEXT =
  "<b>exitbot-evan</b>\n" +
  "/scan — scan wallet on-chain for DLMM positions; pick which ones to manage from the button list\n" +
  "/status — list currently managed positions\n" +
  "/stop — pick a managed position to stop managing (or stop ALL / pause auto-close)\n" +
  "/start — resume auto-close (after \"Stop ALL\")\n" +
  "/forget &lt;positionAddress&gt; — stop managing a position without closing it\n" +
  "/cancel — cancel a pending custom TP/SL prompt\n" +
  "/help — this message";

// /stop picker: one "stop managing this" button per currently managed
// position, plus a "Stop ALL" button that pauses auto-close globally
// (positions stay tracked, resume with /start) rather than forgetting them.
function buildStopKeyboard(managed) {
  const rows = managed.map((p) => ([
    { text: `⛔ ${p.symbol} (${p.positionAddress.slice(0, 6)}…)`, callback_data: `stopone:${p.positionAddress}` },
  ]));
  rows.push([{ text: "🛑 Stop ALL (pause auto-close)", callback_data: "stopall" }]);
  return { inline_keyboard: rows };
}

async function handleStop() {
  const managed = listManaged();
  if (managed.length === 0) {
    await bot.sendHTML("Nothing is currently managed. (Auto-close pause is still available: tap below.)", {
      replyMarkup: { inline_keyboard: [[{ text: "🛑 Stop ALL (pause auto-close)", callback_data: "stopall" }]] },
    });
    return;
  }
  const lines = [
    "Which position should I stop managing?",
    "",
    ...managed.map((p) => `• <b>${esc(p.symbol)}</b> (<code>${esc(p.positionAddress.slice(0, 8))}…</code>) — TP +${p.takeProfitPct}% / SL ${p.stopLossPct}%`),
  ];
  await bot.sendHTML(lines.join("\n"), { replyMarkup: buildStopKeyboard(managed) });
}

function handleStopOne(positionAddress) {
  const ok = forget(positionAddress);
  return { ok, text: ok ? `⛔ Stopped managing ${positionAddress.slice(0, 8)}… (position left untouched on-chain).` : "Position not found in managed positions — try /stop again." };
}

function handleStopAll() {
  setEnabled(false);
  log("listener", "auto-close disabled via /stop → Stop ALL");
  return { ok: true, text: "🛑 Auto-close PAUSED for all positions. Positions remain tracked; send /start to resume." };
}

// Step 1 of adoption: one "pick" button per candidate (numbered to match the
// description lines from describeCandidate() — button text can't hold
// bins/shape/deposit, so the message body carries that). "Manage ALL" skips
// straight to adopting everything with config defaults — custom TP/SL only
// makes sense one position at a time.
function buildPickerKeyboard(candidates) {
  const rows = candidates.map((c, i) => ([
    { text: `#${i + 1}: ${c.symbol}`, callback_data: `pick:${c.positionAddress}` },
  ]));
  if (candidates.length > 1) {
    rows.push([{ text: "✅ Manage ALL (defaults)", callback_data: "adoptall" }]);
  }
  return { inline_keyboard: rows };
}

// Step 2: default-vs-custom choice for one specific candidate.
function buildDefaultOrCustomKeyboard(positionAddress) {
  return {
    inline_keyboard: [
      [{ text: `✅ Use default (TP +${config.takeProfitPct}% / SL ${config.stopLossPct}%)`, callback_data: `adoptdefault:${positionAddress}` }],
      [{ text: "⚙️ Set custom TP/SL", callback_data: `customtp:${positionAddress}` }],
    ],
  };
}

function fmtDeposit(c) {
  if (c.depositSol != null) return `${c.depositSol.toFixed(4)} SOL${c.depositUsd != null ? ` ($${c.depositUsd.toFixed(2)})` : ""}`;
  if (c.depositUsd != null) return `$${c.depositUsd.toFixed(2)}`;
  return "—";
}

function describeCandidate(c, index) {
  return (
    `${index + 1}. <b>${esc(c.symbol)}</b> — <code>${esc(c.positionAddress.slice(0, 8))}…</code>\n` +
    `   Bins: ${c.lowerBinId}–${c.upperBinId} (${c.binCount} bins) · Shape: ${esc(c.shape)}\n` +
    `   Deposit: ${esc(fmtDeposit(c))}`
  );
}

async function handleScan() {
  await bot.sendMessage("🔎 Scanning wallet for on-chain DLMM positions…");
  const { candidates, alreadyTracked, totalPositions, totalPools } = await scanOnChain(
    process.env.HELIUS_RPC_URL,
    process.env.WALLET_ADDRESS,
  );

  if (totalPositions === 0) {
    await bot.sendMessage("No open DLMM positions found on-chain for this wallet.");
    return;
  }

  const lines = [`Found ${totalPositions} open position(s) across ${totalPools} pool(s).`];
  if (alreadyTracked.length > 0) lines.push(`Already managed: ${alreadyTracked.length} (${alreadyTracked.map((a) => a.symbol).join(", ")})`);

  if (candidates.length === 0) {
    lines.push("No new positions to pick from — everything found is already managed.");
    await bot.sendMessage(lines.join("\n"));
    return;
  }

  lines.push("", ...candidates.map((c, i) => describeCandidate(c, i)), "", "Tap a position to choose default or custom TP/SL:");
  await bot.sendHTML(lines.join("\n"), { replyMarkup: buildPickerKeyboard(candidates) });
}

async function handlePick(positionAddress, chatId, messageId) {
  const candidate = getPendingCandidate(positionAddress);
  if (!candidate) return { text: "That candidate is no longer pending — try /scan again." };
  await bot.editMessageText(
    chatId, messageId,
    `<b>${esc(candidate.symbol)}</b> (<code>${esc(positionAddress.slice(0, 8))}…</code>) — how should this be managed?`,
    { replyMarkup: buildDefaultOrCustomKeyboard(positionAddress) },
  );
  return { text: "Pick default or custom TP/SL." };
}

async function handleAdoptDefault(positionAddress) {
  const entry = await adoptCandidate(positionAddress);
  if (!entry) return { ok: false, text: "That candidate is no longer pending — try /scan again." };
  return { ok: true, text: `✅ Now managing ${entry.symbol} (${positionAddress.slice(0, 6)}…) — TP +${entry.takeProfitPct}% / SL ${entry.stopLossPct}%.` };
}

async function handleCustomTpPrompt(positionAddress, chatId, messageId) {
  const candidate = getPendingCandidate(positionAddress);
  if (!candidate) return { text: "That candidate is no longer pending — try /scan again." };
  setAwaitingCustom(positionAddress);
  await bot.editMessageText(
    chatId, messageId,
    `<b>${esc(candidate.symbol)}</b> — send your TP and SL as two numbers, e.g. <code>0.8 -6</code> ` +
    `(TP +0.8%, SL -6%). TP must be positive, SL must be negative.\n` +
    `Optionally add an SL mode as a 3rd word: <code>pnl</code> (default, SL by PnL% only), ` +
    `<code>oorbelow</code> (SL fires as soon as price is out of range below the position, ` +
    `regardless of PnL%), or <code>both</code> (whichever hits first) — e.g. <code>0.8 -6 both</code>.\n` +
    `Send /cancel to abort.`,
  );
  return { text: "Waiting for your TP/SL numbers…" };
}

async function handleAdoptAll() {
  const pending = listPending();
  if (pending.length === 0) return { ok: false, text: "Nothing pending — try /scan again." };
  const adopted = [];
  for (const c of pending) {
    const entry = await adoptCandidate(c.positionAddress);
    if (entry) adopted.push(entry);
  }
  return { ok: true, text: `✅ Now managing ${adopted.length} with defaults: ${adopted.map((a) => a.symbol).join(", ")}` };
}

// Parses "<TP> <SL>" from a plain-text reply while a custom-TP/SL prompt is
// outstanding. Returns { ok, text } — on success, the position is adopted.
const SL_MODE_ALIASES = { pnl: "pnl", oorbelow: "oorBelow", both: "both" };

async function handleCustomTpSlReply(positionAddress, text) {
  const parts = text.trim().split(/\s+/);
  const tp = Number(parts[0]);
  const sl = Number(parts[1]);
  if (parts.length < 2 || parts.length > 3 || !Number.isFinite(tp) || !Number.isFinite(sl)) {
    return { ok: false, text: "Couldn't parse that. Send `TP SL [mode]` like `0.8 -6` or `0.8 -6 both`, or /cancel." };
  }
  if (tp <= 0) return { ok: false, text: "TP must be a positive number (e.g. 0.8 for +0.8%)." };
  if (sl >= 0) return { ok: false, text: "SL must be a negative number (e.g. -6 for -6%)." };

  let slMode = "pnl";
  if (parts.length === 3) {
    slMode = SL_MODE_ALIASES[parts[2].toLowerCase()];
    if (!slMode) return { ok: false, text: "SL mode must be `pnl`, `oorbelow`, or `both`, or /cancel." };
  }

  const entry = await adoptCandidate(positionAddress, { takeProfitPct: tp, stopLossPct: sl, slMode });
  clearAwaitingCustom();
  if (!entry) return { ok: true, text: "That candidate is no longer pending — try /scan again." };
  return { ok: true, text: `✅ Now managing ${entry.symbol} (${positionAddress.slice(0, 6)}…) — custom TP +${tp}% / SL ${sl}%${slMode !== "pnl" ? ` (SL mode: ${slMode})` : ""}.` };
}

export function startListener() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("listener_warn", "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — command listener disabled");
    return;
  }
  const allowedChatId = String(chatId);

  (async () => {
    let offset = loadOffset();
    log("listener", "Telegram command listener started");
    for (;;) {
      try {
        const updates = await bot.getUpdates(offset, { timeout: 25, allowedUpdates: ["message", "callback_query"] });
        for (const update of updates) {
          offset = update.update_id + 1;
          saveOffset(offset);

          // ─── Inline-keyboard taps (position picker) ──────────────────────
          const cq = update.callback_query;
          if (cq) {
            if (String(cq.message?.chat?.id) !== allowedChatId) continue;
            const data = cq.data ?? "";
            const chat = cq.message.chat.id;
            const msgId = cq.message.message_id;
            try {
              let result;
              if (data === "adoptall") {
                result = await handleAdoptAll();
                await bot.answerCallbackQuery(cq.id, { text: result.text });
                if (result.ok) await bot.editMessageText(chat, msgId, esc(result.text));
              } else if (data.startsWith("pick:")) {
                result = await handlePick(data.slice("pick:".length), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("adoptdefault:")) {
                result = await handleAdoptDefault(data.slice("adoptdefault:".length));
                await bot.answerCallbackQuery(cq.id, { text: result.text });
                if (result.ok) await bot.editMessageText(chat, msgId, esc(result.text));
              } else if (data.startsWith("customtp:")) {
                result = await handleCustomTpPrompt(data.slice("customtp:".length), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("stopone:")) {
                result = handleStopOne(data.slice("stopone:".length));
                await bot.answerCallbackQuery(cq.id, { text: result.text });
                if (result.ok) await bot.editMessageText(chat, msgId, esc(result.text));
              } else if (data === "stopall") {
                result = handleStopAll();
                await bot.answerCallbackQuery(cq.id, { text: result.text });
                await bot.editMessageText(chat, msgId, esc(result.text));
              } else {
                continue;
              }
            } catch (e) {
              log("listener_error", `callback handling failed: ${e.message}`);
              await bot.answerCallbackQuery(cq.id, { text: "Error — check logs.", showAlert: true });
            }
            continue;
          }

          // ─── Plain-text commands ───────────────────────────────────────────
          const msg = update.message;
          if (!msg?.text) continue;
          if (String(msg.chat?.id) !== allowedChatId) continue;

          const text = msg.text.trim();

          // A custom-TP/SL prompt takes priority over command parsing, except
          // /cancel and /scan (starting over should always be possible).
          const awaitingPositionAddress = getAwaitingCustom();
          if (awaitingPositionAddress && text !== "/cancel" && !text.startsWith("/scan")) {
            try {
              const result = await handleCustomTpSlReply(awaitingPositionAddress, text);
              await bot.sendMessage(result.text);
            } catch (e) {
              log("listener_error", `custom TP/SL handling failed: ${e.message}`);
              await bot.sendMessage(`❌ Error: ${e.message}`);
            }
            continue;
          }

          const [cmd, ...rest] = text.split(/\s+/);

          if (cmd === "/scan") {
            clearAwaitingCustom();
            try {
              await handleScan();
            } catch (e) {
              log("listener_error", `/scan failed: ${e.message}`);
              await bot.sendMessage(`❌ Scan failed: ${e.message}`);
            }
          } else if (cmd === "/status") {
            await bot.sendRichHTML(await statusText());
          } else if (cmd === "/stop") {
            try {
              await handleStop();
            } catch (e) {
              log("listener_error", `/stop failed: ${e.message}`);
              await bot.sendMessage(`❌ Error: ${e.message}`);
            }
          } else if (cmd === "/start") {
            setEnabled(true);
            await bot.sendMessage("✅ Auto-close RESUMED.");
            log("listener", "auto-close enabled via /start");
          } else if (cmd === "/forget") {
            const positionAddress = rest[0];
            if (!positionAddress) {
              await bot.sendMessage("Usage: /forget <positionAddress>");
            } else {
              const ok = forget(positionAddress);
              await bot.sendMessage(ok ? `Stopped managing ${positionAddress.slice(0, 8)}… (position left untouched on-chain).` : "Position not found in managed positions.");
            }
          } else if (cmd === "/cancel") {
            if (awaitingPositionAddress) {
              clearAwaitingCustom();
              await bot.sendMessage("Cancelled. Send /scan to try again.");
            } else {
              await bot.sendMessage("Nothing to cancel.");
            }
          } else if (cmd === "/help") {
            await bot.sendHTML(HELP_TEXT);
          }
        }
      } catch (e) {
        log("listener_error", `poll loop error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
