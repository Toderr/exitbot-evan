/**
 * Telegram bot — send HTML messages + long-poll getUpdates for commands.
 * Single bot/chat (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — exitbot-evan is
 * a standalone bot, not sharing a token with any screener/trader process.
 */
import { log } from "./logger.js";

const TG_LIMIT = 4000;

function splitForTelegram(html, limit = TG_LIMIT) {
  if (html.length <= limit) return [html];
  const blocks = html.split(/\n\n+/);
  const chunks = [];
  let buf = "";
  for (const block of blocks) {
    const candidate = buf ? `${buf}\n\n${block}` : block;
    if (candidate.length > limit && buf) {
      chunks.push(buf);
      buf = block;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function createTelegram({ token, chatId }) {
  const base = token ? `https://api.telegram.org/bot${token}` : null;

  async function postMessage(body) {
    const res = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) {
      log("telegram_error", `sendMessage ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
      return { ok: false, result: null };
    }
    return { ok: true, result: json?.result ?? null };
  }

  async function postRichMessage(body) {
    const res = await fetch(`${base}/sendRichMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) {
      log("telegram_error", `sendRichMessage ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
      return { ok: false, result: null };
    }
    return { ok: true, result: json?.result ?? null };
  }

  return {
    isEnabled: () => !!(token && chatId),

    async sendHTML(html, opts = {}) {
      if (!base || !chatId) {
        log("telegram_warn", "Telegram not configured — skipping send");
        return null;
      }
      try {
        const chunks = splitForTelegram(html);
        let lastId = null;
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          const body = {
            chat_id: chatId,
            text: chunks[i],
            parse_mode: "HTML",
            disable_web_page_preview: true,
          };
          if (isLast && opts.replyMarkup) body.reply_markup = opts.replyMarkup;
          const { ok, result } = await postMessage(body);
          if (!ok) break;
          if (result?.message_id) lastId = result.message_id;
        }
        return lastId;
      } catch (e) {
        log("telegram_error", `sendHTML failed: ${e.message}`);
        return null;
      }
    },

    /**
     * Send a RichMessage (sendRichMessage) — supports real <table> HTML,
     * unlike classic sendMessage/sendHTML. RichMessage HTML is parsed as
     * real HTML: bare "\n" is collapsed like whitespace — use <br/> for
     * line breaks and blank lines ("\n\n") for block/paragraph breaks.
     * No chunking: the RichMessage limit (32768 chars) is far above the
     * classic 4096 message limit.
     */
    async sendRichHTML(html, opts = {}) {
      if (!base || !chatId) {
        log("telegram_warn", "Telegram not configured — skipping send");
        return null;
      }
      try {
        const body = { chat_id: chatId, rich_message: { html } };
        if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
        const { ok, result } = await postRichMessage(body);
        return ok ? (result?.message_id ?? null) : null;
      } catch (e) {
        log("telegram_error", `sendRichHTML failed: ${e.message}`);
        return null;
      }
    },

    async sendMessage(text) {
      if (!base || !chatId) return;
      try {
        const res = await fetch(`${base}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4096) }),
        });
        if (!res.ok) {
          const err = await res.text();
          log("telegram_error", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
        }
      } catch (e) {
        log("telegram_error", `sendMessage failed: ${e.message}`);
      }
    },

    async answerCallbackQuery(callbackQueryId, { text, showAlert = false } = {}) {
      if (!base) return;
      try {
        await fetch(`${base}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: text ? String(text).slice(0, 200) : undefined,
            show_alert: showAlert,
          }),
        });
      } catch (e) {
        log("telegram_error", `answerCallbackQuery failed: ${e.message}`);
      }
    },

    /** Replace inline keyboard on an existing message (pass null to remove). */
    async editMessageReplyMarkup(msgChatId, messageId, replyMarkup) {
      if (!base) return;
      try {
        const res = await fetch(`${base}/editMessageReplyMarkup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msgChatId,
            message_id: messageId,
            reply_markup: replyMarkup ?? { inline_keyboard: [] },
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          log("telegram_error", `editMessageReplyMarkup ${res.status}: ${err.slice(0, 100)}`);
        }
      } catch (e) {
        log("telegram_error", `editMessageReplyMarkup failed: ${e.message}`);
      }
    },

    /** Edit an existing message's text (HTML). */
    async editMessageText(msgChatId, messageId, html, opts = {}) {
      if (!base) return;
      try {
        const res = await fetch(`${base}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msgChatId,
            message_id: messageId,
            text: html,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: opts.replyMarkup,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          log("telegram_error", `editMessageText ${res.status}: ${err.slice(0, 100)}`);
        }
      } catch (e) {
        log("telegram_error", `editMessageText failed: ${e.message}`);
      }
    },

    async getUpdates(offset, { timeout = 25, allowedUpdates = ["message"] } = {}) {
      if (!base) return [];
      try {
        const res = await fetch(`${base}/getUpdates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset, timeout, allowed_updates: allowedUpdates }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || json?.ok === false) {
          log("telegram_error", `getUpdates ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
          return [];
        }
        return json?.result ?? [];
      } catch (e) {
        log("telegram_error", `getUpdates failed: ${e.message}`);
        return [];
      }
    },
  };
}

const bot = createTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
});

export const isEnabled              = bot.isEnabled;
export const sendHTML               = bot.sendHTML;
export const sendRichHTML           = bot.sendRichHTML;
export const sendMessage            = bot.sendMessage;
export const getUpdates             = bot.getUpdates;
export const answerCallbackQuery    = bot.answerCallbackQuery;
export const editMessageReplyMarkup = bot.editMessageReplyMarkup;
export const editMessageText        = bot.editMessageText;
export default bot;
