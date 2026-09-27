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
  forget,
  setAwaitingCustom,
  getAwaitingCustom,
  clearAwaitingCustom,
  rebalanceEntry,
  getRebalanceTarget,
  setAwaitingRebalance,
  getAwaitingRebalance,
  clearAwaitingRebalance,
  setAwaitingOor,
  getAwaitingOor,
  clearAwaitingOor,
} from "./manager.js";
import { card } from "./richCard.js";

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
  "   exit presets per position: default TP/SL · custom TP/SL · 📈 Indicator Exit " +
  "(15m RSI(2)&gt;90 AND (MACD first green histogram OR close &gt; upper Bollinger) — " +
  "SL is opt-in with your own percent, OOR still applies)\n" +
  "/status — list currently managed positions\n" +
  "/rebalance — pick a position (managed or not yet managed), choose a shape/range/deposit amount, and recenter its liquidity to the current price — " +
  "quote (SOL) side only, strictly below the active bin\n" +
  "/stop — pick a managed position to stop managing (or stop ALL managed positions)\n" +
  "/forget &lt;positionAddress&gt; — stop managing a position without closing it\n" +
  "/cancel — cancel a pending custom TP/SL prompt\n" +
  "/help — this message";

// /stop picker: one "stop managing this" button per currently managed
// position, plus a "Stop ALL" button that forgets every currently managed
// position (each left untouched on-chain) — the bot itself keeps running
// and will pick up new positions again via /scan.
function buildStopKeyboard(managed) {
  const rows = managed.map((p) => ([
    { text: `⛔ ${p.symbol} (${p.positionAddress.slice(0, 6)}…)`, callback_data: `stopone:${p.positionAddress}` },
  ]));
  if (managed.length > 1) {
    rows.push([{ text: "🛑 Stop ALL (forget all managed positions)", callback_data: "stopall" }]);
  }
  return { inline_keyboard: rows };
}

async function handleStop() {
  const managed = listManaged();
  if (managed.length === 0) {
    await bot.sendMessage("Nothing is currently managed.");
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
  const managed = listManaged();
  for (const p of managed) forget(p.positionAddress);
  log("listener", `stopped managing all ${managed.length} position(s) via /stop → Stop ALL`);
  return { ok: true, text: `⛔ Stopped managing all ${managed.length} position(s) (left untouched on-chain).` };
}

// /rebalance picker: one button per position — managed ones first, then
// every unmanaged SOL-quoted position found by a fresh on-chain scan — then
// a confirm step: this moves real on-chain funds (withdraw + redeposit), so
// a single button tap from /stop's list isn't enough; require a second
// explicit tap.
function buildRebalanceKeyboard(managed, unmanaged) {
  return {
    inline_keyboard: [
      ...managed.map((p) => ([
        { text: `⚖️ ${p.symbol} (${p.positionAddress.slice(0, 6)}…)`, callback_data: `rebalpick:${p.positionAddress}` },
      ])),
      ...unmanaged.map((p) => ([
        { text: `🆕 ${p.symbol} (${p.positionAddress.slice(0, 6)}…) — unmanaged`, callback_data: `rebalpick:${p.positionAddress}` },
      ])),
    ],
  };
}

async function handleRebalance() {
  const managed = listManaged();
  await bot.sendMessage("🔎 Scanning wallet for positions to rebalance…");
  let unmanaged = [];
  try {
    ({ candidates: unmanaged } = await scanOnChain(process.env.HELIUS_RPC_URL, process.env.WALLET_ADDRESS));
  } catch (e) {
    log("listener_error", `/rebalance scan failed: ${e.message}`);
    if (managed.length === 0) throw e;
    await bot.sendMessage(`⚠️ On-chain scan failed (${e.message}) — only managed positions are listed.`);
  }
  if (managed.length === 0 && unmanaged.length === 0) {
    await bot.sendMessage("No open SOL-quoted DLMM positions found.");
    return;
  }
  const describe = (p) => `• <b>${esc(p.symbol)}</b> (<code>${esc(p.positionAddress.slice(0, 8))}…</code>) — bins ${p.lowerBinId}–${p.upperBinId}`;
  const lines = ["Which position should I recenter to the current price?"];
  if (managed.length > 0) lines.push("", "<b>Managed:</b>", ...managed.map(describe));
  if (unmanaged.length > 0) lines.push("", "<b>Not managed</b> (rebalancing won't adopt it):", ...unmanaged.map(describe));
  await bot.sendHTML(lines.join("\n"), { replyMarkup: buildRebalanceKeyboard(managed, unmanaged) });
}

// Step 2: shape choice for the recentered (quote-only) range.
function buildRebalanceShapeKeyboard(positionAddress) {
  return {
    inline_keyboard: [
      [{ text: "◼️ Spot", callback_data: `rebalshape:${positionAddress}:Spot` }],
      [{ text: "⛰️ Curve", callback_data: `rebalshape:${positionAddress}:Curve` }],
      [{ text: "🦅 Bid-Ask", callback_data: `rebalshape:${positionAddress}:BidAsk` }],
    ],
  };
}

async function handleRebalancePick(positionAddress, chatId, messageId) {
  const entry = getRebalanceTarget(positionAddress);
  if (!entry) return { text: "That position is no longer available — send /rebalance again." };
  clearAwaitingRebalance();
  await bot.editMessageText(
    chatId, messageId,
    `<b>${esc(entry.symbol)}</b> (<code>${esc(positionAddress.slice(0, 8))}…</code>) — current bins ${entry.lowerBinId}–${entry.upperBinId}.\n` +
    `This withdraws 100% of the position (+ fees) and redeposits <b>quote (SOL) side only</b>, strictly below the current price (never touching the active bin) — pick the deposit shape:`,
    { replyMarkup: buildRebalanceShapeKeyboard(positionAddress) },
  );
  return { text: "Pick a shape." };
}

async function handleRebalanceShapePick(positionAddress, shape, chatId, messageId) {
  const entry = getRebalanceTarget(positionAddress);
  if (!entry) return { text: "That position is no longer available — send /rebalance again." };
  setAwaitingRebalance(positionAddress, "range", { shape });
  await bot.editMessageText(
    chatId, messageId,
    `<b>${esc(entry.symbol)}</b> — shape: <b>${esc(shape)}</b>.\n` +
    `Send the bin range width (how many bins below the current price), e.g. <code>20</code>. Send /cancel to abort.`,
  );
  return { text: "Waiting for range width…" };
}

async function handleRebalanceRangeReply(awaiting, text) {
  const rangeBins = Number(text.trim());
  if (!Number.isInteger(rangeBins) || rangeBins <= 0) {
    return { ok: false, text: "Couldn't parse that. Send a positive whole number of bins, e.g. 20, or /cancel." };
  }
  setAwaitingRebalance(awaiting.positionAddress, "deposit", { shape: awaiting.shape, rangeBins });
  return {
    ok: true,
    text: `Range: <b>${rangeBins}</b> bins below current price.\n` +
      `Send the SOL amount to deposit (e.g. <code>0.5</code>), or <code>max</code> to redeposit everything withdrawn from this position. /cancel to abort.`,
  };
}

const MAX_DEPOSIT_ALIASES = new Set(["max", "maks", "semua", "all"]);

async function handleRebalanceDepositReply(awaiting, text) {
  const raw = text.trim().toLowerCase();
  let depositSol = null;
  if (!MAX_DEPOSIT_ALIASES.has(raw)) {
    depositSol = Number(raw);
    if (!Number.isFinite(depositSol) || depositSol <= 0) {
      return { ok: false, text: "Couldn't parse that. Send a positive SOL amount (e.g. 0.5), `max`, or /cancel." };
    }
  }
  setAwaitingRebalance(awaiting.positionAddress, "confirm", { shape: awaiting.shape, rangeBins: awaiting.rangeBins, depositSol });
  const entry = getRebalanceTarget(awaiting.positionAddress);
  const depositLabel = depositSol != null ? `${depositSol} SOL` : "everything withdrawn (max)";
  return {
    ok: true,
    text: `<b>${esc(entry?.symbol ?? awaiting.positionAddress.slice(0, 8))}</b> — confirm rebalance:\n` +
      `Shape: <b>${esc(awaiting.shape)}</b> · Range: <b>${awaiting.rangeBins}</b> bins below price · Deposit: <b>${esc(depositLabel)}</b>`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: "✅ Confirm rebalance", callback_data: `rebalconfirm:${awaiting.positionAddress}` }],
        [{ text: "❌ Cancel", callback_data: "rebalcancel" }],
      ],
    },
  };
}

async function handleRebalanceConfirm(positionAddress, chatId, messageId) {
  const awaiting = getAwaitingRebalance();
  if (!awaiting || awaiting.positionAddress !== positionAddress || awaiting.step !== "confirm") {
    return { ok: false, text: "This rebalance prompt has expired — send /rebalance again." };
  }
  clearAwaitingRebalance();
  await bot.editMessageText(chatId, messageId, `⏳ Rebalancing <code>${esc(positionAddress.slice(0, 8))}…</code>…`);
  const result = await rebalanceEntry(positionAddress, {
    shape: awaiting.shape,
    rangeBins: awaiting.rangeBins,
    depositSol: awaiting.depositSol,
  });
  if (!result.ok) {
    return { ok: false, text: `❌ Rebalance failed: ${esc(result.error)}` };
  }
  const { entry, managed, sigs, depositedSol } = result;
  return {
    ok: true,
    text: `⚖️ <b>Rebalanced</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(positionAddress.slice(0, 8))}…</code>)\n` +
      `New bins: ${entry.lowerBinId}–${entry.upperBinId} (quote-only)\n` +
      `Deposited: <b>${depositedSol.toFixed(4)} SOL</b>\n` +
      sigs.map((s) => `<code>${esc(s.slice(0, 20))}…</code>`).join("\n") +
      (managed ? "" : "\n\nThis position is <b>not managed</b> — tap below to pick an exit preset for it, or leave it unmanaged."),
    // Unmanaged: offer adoption straight away — reuses the /scan picker's
    // pick: flow, since rebalanceEntry left it in pending-scan.json.
    replyMarkup: managed ? undefined : {
      inline_keyboard: [[{ text: `🛡️ Manage ${entry.symbol}`, callback_data: `pick:${positionAddress}` }]],
    },
  };
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

// Step 2: exit-preset choice for one specific candidate — default TP/SL,
// custom TP/SL, or Indicator Exit (15m RSI/MACD/Bollinger instead of a PnL
// take-profit; SL/OOR still apply).
function buildDefaultOrCustomKeyboard(positionAddress) {
  const ind = config.indicatorExit ?? {};
  return {
    inline_keyboard: [
      [{ text: `✅ Use default (TP +${config.takeProfitPct}% / SL ${config.stopLossPct}%)`, callback_data: `adoptdefault:${positionAddress}` }],
      [{ text: "⚙️ Set custom TP/SL", callback_data: `customtp:${positionAddress}` }],
      [{ text: `📈 Indicator Exit (RSI${ind.rsiPeriod ?? 2}>${ind.rsiThreshold ?? 90} + MACD/BB ${ind.timeframeMinutes ?? 15}m)`, callback_data: `indicatorpick:${positionAddress}` }],
    ],
  };
}

// Step 2b: once Indicator Exit is picked, SL is opt-in — ask whether to add
// one at all before asking for the percent (kept as two taps/one text reply
// rather than folding "percent, or blank for none" into a single prompt, so
// declining SL doesn't require typing anything).
function buildIndicatorSlKeyboard(positionAddress) {
  return {
    inline_keyboard: [
      [{ text: "🛡️ Add Stop Loss", callback_data: `indicatorsl:${positionAddress}` }],
      [{ text: "🚫 No Stop Loss (indicator exit only)", callback_data: `indicatornosl:${positionAddress}` }],
    ],
  };
}

function fmtDeposit(c) {
  if (c.depositSol != null) return `${c.depositSol.toFixed(4)} SOL${c.depositUsd != null ? ` ($${c.depositUsd.toFixed(2)})` : ""}`;
  if (c.depositUsd != null) return `$${c.depositUsd.toFixed(2)}`;
  return "—";
}

function describeCandidate(c, index) {
  return card({
    emoji: "🔎",
    title: `#${index + 1} Scan Candidate`,
    subtitle: `<b>${esc(c.symbol)}</b>`,
    rows: [
      ["Position", `<code>${esc(c.positionAddress.slice(0, 8))}…</code>`],
      ["Bins", `${c.lowerBinId}–${c.upperBinId} (${c.binCount} bins)`],
      ["Shape", esc(c.shape)],
      ["Deposit", esc(fmtDeposit(c))],
    ],
  });
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

  const plainLines = [`Found ${totalPositions} open position(s) across ${totalPools} pool(s).`];
  if (alreadyTracked.length > 0) plainLines.push(`Already managed: ${alreadyTracked.length} (${alreadyTracked.map((a) => a.symbol).join(", ")})`);

  if (candidates.length === 0) {
    plainLines.push("No new positions to pick from — everything found is already managed.");
    await bot.sendMessage(plainLines.join("\n"));
    return;
  }

  const blocks = [
    `<p>${plainLines.join("<br/>")}</p>`,
    ...candidates.map((c, i) => describeCandidate(c, i)),
    "<p>Tap a position to choose its exit preset (default TP/SL, custom TP/SL, or Indicator Exit):</p>",
  ];
  await bot.sendRichHTML(blocks.join("\n\n"), { replyMarkup: buildPickerKeyboard(candidates) });
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

async function handleIndicatorPick(positionAddress, chatId, messageId) {
  const candidate = getPendingCandidate(positionAddress);
  if (!candidate) return { text: "That candidate is no longer pending — try /scan again." };
  await bot.editMessageText(
    chatId, messageId,
    `<b>${esc(candidate.symbol)}</b> — Indicator Exit selected. Add a Stop Loss too?`,
    { replyMarkup: buildIndicatorSlKeyboard(positionAddress) },
  );
  return { text: "Choose whether to add a Stop Loss." };
}

function describeIndicatorAdoption(entry) {
  const ind = config.indicatorExit ?? {};
  const tf = ind.timeframeMinutes ?? 15;
  const oorOn = (ind.keepOorClose ?? true) && config.oorCloseEnabled;
  let slPart, oorPart;
  if (entry.slEnabled) {
    slPart = `SL ${entry.stopLossPct}%`;
    oorPart = oorOn ? " · OOR close on" : "";
  } else {
    slPart = "SL off";
    // No SL chosen: a downside break no longer auto-closes (that's what
    // declining SL means) — only alerts. OOR-above (a runaway favorable
    // move) still closes as normal.
    oorPart = oorOn ? " · OOR-above still auto-closes; OOR-below alerts only, won't close" : "";
  }
  return `📈 Now managing ${entry.symbol} (${entry.positionAddress.slice(0, 6)}…) with Indicator Exit — ` +
    `RSI(${ind.rsiPeriod ?? 2}) > ${ind.rsiThreshold ?? 90} on ${tf}m AND (MACD first green histogram OR close > upper BB). ` +
    `${slPart}${oorPart}.`;
}

async function handleAdoptIndicatorNoSl(positionAddress) {
  const entry = await adoptCandidate(positionAddress, { exitMode: "indicator", indicatorSlEnabled: false });
  if (!entry) return { ok: false, text: "That candidate is no longer pending — try /scan again." };
  return { ok: true, text: describeIndicatorAdoption(entry) };
}

async function handleIndicatorSlPrompt(positionAddress, chatId, messageId) {
  const candidate = getPendingCandidate(positionAddress);
  if (!candidate) return { text: "That candidate is no longer pending — try /scan again." };
  setAwaitingCustom(positionAddress, "indicatorSl");
  await bot.editMessageText(
    chatId, messageId,
    `<b>${esc(candidate.symbol)}</b> — kirim angka SL kamu (isi <b>positif</b>, jangan pakai minus).\n` +
    `Contoh: <code>6</code> → SL -6% PnL.\n` +
    `Kirim /cancel untuk membatalkan.`,
  );
  return { text: "Waiting for your SL number…" };
}

async function handleIndicatorSlReply(positionAddress, text) {
  const raw = Number(text.trim());
  if (!Number.isFinite(raw)) return { ok: false, text: "Nggak kebaca. Kirim angka positif, contoh 6, atau /cancel." };
  if (raw === 0) return { ok: false, text: "SL harus lebih dari 0 (contoh: 6 untuk -6%)." };
  const sl = -Math.abs(raw);

  const entry = await adoptCandidate(positionAddress, { exitMode: "indicator", indicatorSlEnabled: true, stopLossPct: sl });
  clearAwaitingCustom();
  if (!entry) return { ok: true, text: "That candidate is no longer pending — try /scan again." };
  return { ok: true, text: describeIndicatorAdoption(entry) };
}

async function handleCustomTpPrompt(positionAddress, chatId, messageId) {
  const candidate = getPendingCandidate(positionAddress);
  if (!candidate) return { text: "That candidate is no longer pending — try /scan again." };
  setAwaitingCustom(positionAddress);
  await bot.editMessageText(
    chatId, messageId,
    `<b>${esc(candidate.symbol)}</b> — atur TP dan SL kamu\n\n` +
    `Format: <code>TP SL [mode]</code>\n` +
    `Contoh: <code>0.8 6</code> → TP +0.8%, SL -6%\n` +
    `(TP dan SL sama-sama diisi angka positif)\n\n` +
    `Kata ke-3 opsional — mode SL:\n` +
    `• <code>pnl</code> — SL berdasarkan PnL% saja (default)\n` +
    `• <code>oorbelow</code> — SL langsung aktif begitu harga keluar dari range\n` +
    `• <code>both</code> — mana yang lebih dulu tercapai\n` +
    `Contoh: <code>0.8 6 both</code>\n\n` +
    `Kirim /cancel untuk membatalkan.`,
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

// ─── OOR-duration step ─────────────────────────────────────────────────────
// Only meaningful when slMode is "oorBelow"/"both" — that's the only case an
// OOR-below break is a close trigger at all (plain "pnl" mode and Indicator
// Exit always just alert on it, never close), so this step is only asked
// then, right after the custom TP/SL text reply.
function buildOorKeyboard(positionAddress) {
  return {
    inline_keyboard: [
      [{ text: "⚡ Instan (langsung close)", callback_data: `oor:${positionAddress}:0` }],
      [{ text: "🕔 5 menit", callback_data: `oor:${positionAddress}:300` }],
      [{ text: "🕒 15 menit", callback_data: `oor:${positionAddress}:900` }],
      [{ text: "🕐 1 jam", callback_data: `oor:${positionAddress}:3600` }],
      [{ text: "✏️ Custom", callback_data: `oorcustom:${positionAddress}` }],
    ],
  };
}

async function handleOorCustomPrompt(positionAddress, chatId, messageId) {
  const awaiting = getAwaitingOor();
  if (!awaiting || awaiting.positionAddress !== positionAddress) {
    return { text: "Prompt ini sudah kedaluwarsa — kirim /scan lagi." };
  }
  setAwaitingCustom(positionAddress, "oorMinutes");
  await bot.editMessageText(
    chatId, messageId,
    `Kirim durasi OOR dalam menit (angka positif), contoh <code>10</code> untuk 10 menit. Kirim /cancel untuk membatalkan.`,
  );
  return { text: "Waiting for OOR duration…" };
}

async function handleOorMinutesReply(positionAddress, text) {
  const minutes = Number(text.trim());
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, text: "Nggak kebaca. Kirim angka menit positif, contoh 10, atau /cancel." };
  }
  return finalizeOorAdoption(positionAddress, Math.round(minutes * 60));
}

async function finalizeOorAdoption(positionAddress, oorCloseDurationSec) {
  const awaiting = getAwaitingOor();
  if (!awaiting || awaiting.positionAddress !== positionAddress) {
    return { ok: false, text: "Prompt ini sudah kedaluwarsa — kirim /scan lagi." };
  }
  clearAwaitingOor();
  clearAwaitingCustom();
  const entry = await adoptCandidate(positionAddress, { ...awaiting.overrides, oorCloseDurationSec });
  if (!entry) return { ok: true, text: "That candidate is no longer pending — try /scan again." };
  const graceLabel = oorCloseDurationSec > 0 ? `${oorCloseDurationSec}s` : "instan";
  return {
    ok: true,
    text: `✅ Now managing ${entry.symbol} (${positionAddress.slice(0, 6)}…) — custom TP +${entry.takeProfitPct}% / SL ${entry.stopLossPct}% (SL mode: ${entry.slMode}). OOR grace: ${graceLabel}.`,
  };
}

// Parses "<TP> <SL>" from a plain-text reply while a custom-TP/SL prompt is
// outstanding. Returns { ok, text } — on success, either the position is
// adopted directly, or (slMode oorBelow/both) the OOR-duration step starts.
const SL_MODE_ALIASES = { pnl: "pnl", oorbelow: "oorBelow", both: "both" };

async function handleCustomTpSlReply(positionAddress, text) {
  const parts = text.trim().split(/\s+/);
  const tp = Number(parts[0]);
  const slRaw = Number(parts[1]);
  if (parts.length < 2 || parts.length > 3 || !Number.isFinite(tp) || !Number.isFinite(slRaw)) {
    return { ok: false, text: "Nggak kebaca. Kirim `TP SL [mode]` contoh `0.8 6` atau `0.8 6 both` (keduanya positif), atau /cancel." };
  }
  if (tp <= 0) return { ok: false, text: "TP harus angka positif (contoh 0.8 untuk +0.8%)." };
  if (slRaw <= 0) return { ok: false, text: "SL harus angka positif, jangan pakai minus (contoh 6 untuk -6%)." };
  const sl = -Math.abs(slRaw);

  let slMode = "pnl";
  if (parts.length === 3) {
    slMode = SL_MODE_ALIASES[parts[2].toLowerCase()];
    if (!slMode) return { ok: false, text: "SL mode must be `pnl`, `oorbelow`, or `both`, or /cancel." };
  }

  if (slMode === "oorBelow" || slMode === "both") {
    clearAwaitingCustom();
    setAwaitingOor(positionAddress, { takeProfitPct: tp, stopLossPct: sl, slMode });
    return {
      ok: true,
      text: `TP +${tp}% / SL ${sl}% (mode: ${slMode}) — SL mode ini bisa close langsung begitu harga keluar dari range bawah. ` +
        `Berapa lama harga boleh keluar range sebelum auto-close?`,
      replyMarkup: buildOorKeyboard(positionAddress),
    };
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
              } else if (data.startsWith("indicatorpick:")) {
                result = await handleIndicatorPick(data.slice("indicatorpick:".length), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("indicatornosl:")) {
                result = await handleAdoptIndicatorNoSl(data.slice("indicatornosl:".length));
                await bot.answerCallbackQuery(cq.id, { text: result.text.slice(0, 190) });
                if (result.ok) await bot.editMessageText(chat, msgId, esc(result.text));
              } else if (data.startsWith("indicatorsl:")) {
                result = await handleIndicatorSlPrompt(data.slice("indicatorsl:".length), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("customtp:")) {
                result = await handleCustomTpPrompt(data.slice("customtp:".length), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("oorcustom:")) {
                result = await handleOorCustomPrompt(data.slice("oorcustom:".length), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("oor:")) {
                const rest = data.slice("oor:".length);
                const sep = rest.lastIndexOf(":");
                const posAddr = rest.slice(0, sep);
                const seconds = Number(rest.slice(sep + 1));
                result = await finalizeOorAdoption(posAddr, seconds);
                await bot.answerCallbackQuery(cq.id, { text: result.text.slice(0, 190) });
                if (result.ok) await bot.editMessageText(chat, msgId, esc(result.text));
              } else if (data.startsWith("rebalpick:")) {
                result = await handleRebalancePick(data.slice("rebalpick:".length), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("rebalshape:")) {
                const rest = data.slice("rebalshape:".length);
                const sep = rest.lastIndexOf(":");
                result = await handleRebalanceShapePick(rest.slice(0, sep), rest.slice(sep + 1), chat, msgId);
                await bot.answerCallbackQuery(cq.id, { text: result.text });
              } else if (data.startsWith("rebalconfirm:")) {
                // Answer the tap immediately — the rebalance itself (two
                // on-chain txs) can easily run past Telegram's callback-query
                // answer window, so the final result is delivered via
                // editMessageText instead, which has no such deadline.
                await bot.answerCallbackQuery(cq.id, { text: "Rebalancing…" });
                try {
                  result = await handleRebalanceConfirm(data.slice("rebalconfirm:".length), chat, msgId);
                  await bot.editMessageText(chat, msgId, result.text, { replyMarkup: result.replyMarkup });
                } catch (e) {
                  log("listener_error", `rebalance failed: ${e.message}`);
                  await bot.editMessageText(chat, msgId, `❌ Rebalance failed: ${esc(e.message)}`);
                }
              } else if (data === "rebalcancel") {
                clearAwaitingRebalance();
                await bot.answerCallbackQuery(cq.id, { text: "Cancelled." });
                await bot.editMessageText(chat, msgId, "Rebalance cancelled.");
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

          // A /rebalance range or deposit prompt takes priority over command
          // parsing, except /cancel and /rebalance (starting over should
          // always be possible).
          const awaitingRebal = getAwaitingRebalance();
          if (awaitingRebal && text !== "/cancel" && !text.startsWith("/rebalance") && (awaitingRebal.step === "range" || awaitingRebal.step === "deposit")) {
            try {
              const result = awaitingRebal.step === "range"
                ? await handleRebalanceRangeReply(awaitingRebal, text)
                : await handleRebalanceDepositReply(awaitingRebal, text);
              await bot.sendHTML(result.text, { replyMarkup: result.replyMarkup });
            } catch (e) {
              log("listener_error", `rebalance reply handling failed: ${e.message}`);
              await bot.sendMessage(`❌ Error: ${e.message}`);
            }
            continue;
          }

          // A custom-TP/SL or indicator-SL prompt takes priority over command
          // parsing, except /cancel and /scan (starting over should always be
          // possible).
          const awaiting = getAwaitingCustom();
          if (awaiting && text !== "/cancel" && !text.startsWith("/scan")) {
            try {
              const result = awaiting.kind === "indicatorSl"
                ? await handleIndicatorSlReply(awaiting.positionAddress, text)
                : awaiting.kind === "oorMinutes"
                ? await handleOorMinutesReply(awaiting.positionAddress, text)
                : await handleCustomTpSlReply(awaiting.positionAddress, text);
              await bot.sendHTML(result.text, { replyMarkup: result.replyMarkup });
            } catch (e) {
              log("listener_error", `custom reply handling failed: ${e.message}`);
              await bot.sendMessage(`❌ Error: ${e.message}`);
            }
            continue;
          }

          const [cmd, ...rest] = text.split(/\s+/);

          if (cmd === "/scan") {
            clearAwaitingCustom();
            clearAwaitingRebalance();
            clearAwaitingOor();
            try {
              await handleScan();
            } catch (e) {
              log("listener_error", `/scan failed: ${e.message}`);
              await bot.sendMessage(`❌ Scan failed: ${e.message}`);
            }
          } else if (cmd === "/status") {
            await bot.sendRichHTML(await statusText());
          } else if (cmd === "/rebalance") {
            clearAwaitingRebalance();
            try {
              await handleRebalance();
            } catch (e) {
              log("listener_error", `/rebalance failed: ${e.message}`);
              await bot.sendMessage(`❌ Error: ${e.message}`);
            }
          } else if (cmd === "/stop") {
            try {
              await handleStop();
            } catch (e) {
              log("listener_error", `/stop failed: ${e.message}`);
              await bot.sendMessage(`❌ Error: ${e.message}`);
            }
          } else if (cmd === "/forget") {
            const positionAddress = rest[0];
            if (!positionAddress) {
              await bot.sendMessage("Usage: /forget <positionAddress>");
            } else {
              const ok = forget(positionAddress);
              await bot.sendMessage(ok ? `Stopped managing ${positionAddress.slice(0, 8)}… (position left untouched on-chain).` : "Position not found in managed positions.");
            }
          } else if (cmd === "/cancel") {
            if (awaiting) {
              clearAwaitingCustom();
              clearAwaitingOor();
              await bot.sendMessage("Cancelled. Send /scan to try again.");
            } else if (awaitingRebal) {
              clearAwaitingRebalance();
              await bot.sendMessage("Rebalance cancelled. Send /rebalance to try again.");
            } else if (getAwaitingOor()) {
              clearAwaitingOor();
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
