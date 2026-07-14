# exitbot-evan

Standalone position-exit bot for a manually-opened Meteora DLMM LP position.
Reuses `evilpanda-screener`'s manager exit logic (SL/TP/OOR auto-close), but
runs as its own process with its own Telegram bot, and does **not** poll
on-chain continuously — it only discovers positions when you send `/scan`.

## Why a separate bot

evilpanda-screener's manager only manages positions its own trader opened
(read from `state/trader-positions.json`) — a manually-opened position is
invisible to it. exitbot-evan exists to manage *your* manually-opened
position(s) without touching evilpanda-screener's state or needing a trader/
screener behind it at all.

## Quick start

```bash
npm install
cp .env.example .env      # fill in HELIUS_RPC_URL, WALLET_ADDRESS,
                           # SOLANA_PRIVATE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
npm start                  # starts the Telegram listener + 15s exit-check cron
node index.js --once       # run one exit-check tick on currently-managed positions, then exit
```

Create a **new** Telegram bot via @BotFather for `TELEGRAM_BOT_TOKEN` — don't
reuse evilpanda-screener's tokens, so alerts/commands stay separated.

## How it works

1. DM the bot `/scan`. It enumerates your wallet's on-chain DLMM positions
   (`api/meteora.js:fetchUserPositions`, one `getProgramAccounts` call) and
   sends back a button for each open SOL-quoted **position** that isn't
   already managed — one button per position, not per pool, so if you hold
   two positions in the same pool you get two buttons (plus a "Manage ALL"
   button when there's more than one candidate). Nothing is adopted yet at
   this point — candidates just sit in `state/pending-scan.json`.
2. Each candidate's message includes its bin range, an inferred deposit
   shape (Spot/Curve/Bid-Ask — heuristic from per-bin liquidity, since Meteora
   doesn't store the original shape after the fact), and total deposit
   (SOL/USD, from the Meteora datapi's `allTimeDeposits` — the historical
   amount put in, not the current live balance).
3. Tap a button (or "Manage ALL") to actually adopt that position into
   `state/positions.json`, with default SL/TP from `config.js` and a MCap
   snapshot from DexScreener (for the high-TVL guard). Only tapped positions
   get managed — anything you don't pick is left alone. Each position is
   tracked and closed independently, even when two share a pool.
3. Every 15 seconds (`config.cronSchedule`), for each *managed* position:
   fetch PnL/range from the Meteora datapi (`fetchDlmmPnl`), apply the
   high-TVL guard, and check SL/TP/OOR. On trigger: withdraw the position,
   swap the token side to SOL (Jupiter, Meteora fallback), log to
   `state/journal.jsonl`, remove from state, and notify Telegram.
4. `/scan` again any time you open a new position manually — it'll show up
   as a new button (already-managed ones won't re-appear).

No continuous RPC polling happens outside of a `/scan` call or a managed
position's 15s PnL check — this bot never touches positions you haven't
explicitly told it about.

## Thresholds (`config.js`)

Mirrors evilpanda-screener's live `config.trader.*` (checked 2026-07-11, not
its older README figures):
- SL: -7% PnL
- TP: +0.5% PnL
- OOR: auto-close enabled (either direction — independent of SL mode below)
- SL mode (`config.slMode`, default `"pnl"`, overridable per-position via the
  /scan custom TP/SL flow): `"pnl"` fires SL only on PnL% ≤ threshold (legacy
  default); `"oorBelow"` fires SL as soon as price is out of range *below*
  the position's lower bin, regardless of PnL%; `"both"` fires on whichever
  hits first
- SL requires 2 consecutive 15s ticks at/below threshold (datapi glitch filter,
  applies to whichever condition slMode is evaluating)
- High-TVL guard: if pool TVL > 20% of the token's MCap (from DexScreener at
  scan time), tighten TP to +0.1% until TVL/MCap drops back down (SL is left
  untouched). **Only applies to positions still on the default TP/SL** — if
  you set a custom TP/SL via the /scan picker, the high-TVL guard never
  touches it (same rule as the runner alert below).
- Runner alert: if a position's Meteora dynamic fee > 1% AND its 15m candle is
  green with a >5% move (confirmed via GeckoTerminal OHLCV, ported from
  evilpanda-screener's `watcher.js`), bump TP to +1% until dynamic fee drops
  back under 1% — a sustained fee spike signals a real mover, so profit-taking
  is relaxed instead of cutting it short at the normal default. Runs after the
  high-TVL guard each tick and overrides its TP (not SL) while active; when it
  clears, TP falls back to whatever the high-TVL guard/base value already is.
  **Only applies to positions still on the default TP/SL** — if you set a
  custom TP/SL via the /scan picker, the runner alert never touches it.

These are independent of evilpanda-screener's config — update both if you
want them to stay in sync.

## Telegram commands

| Command | Effect |
|---|---|
| `/scan` | Enumerate wallet on-chain, show a button per new SOL-quoted position (one per position, not per pool) to pick which to manage |
| `/status` | List currently managed positions + their TP/SL |
| `/stop` | Show a picker: stop managing one specific position, or "Stop ALL" to pause auto-close globally (positions stay tracked, no closes fire) |
| `/start` | Resume auto-close (after a "Stop ALL") |
| `/forget <positionAddress>` | Stop managing a position directly by address (does not close it on-chain) |
| `/help` | Show command list |

Only `TELEGRAM_CHAT_ID` is honored — other chats are ignored (this bot signs
transactions).

## Architecture

```
index.js              — entry point (listener + 15s cron)
config.js              — thresholds
manager.js              — /scan candidate discovery, adoption, snapshot, high-TVL guard, SL/TP/OOR close
telegramListener.js     — command + inline-keyboard long-poll (/scan picker, /status /start /stop /forget /help)
telegram.js             — HTML sender + getUpdates
logger.js               — file + console logger (logs/exitbot-YYYY-MM-DD.log)
api/
  meteora.js            — on-chain position enumeration, datapi PnL, withdraw, swap fallback
  jupiter.js             — Jupiter swap (post-close token→SOL)
  dexscreener.js          — MCap lookup for the high-TVL guard (no API key needed)
  geckoterminal.js        — 15m OHLCV for the runner-alert candle confirmation (no API key needed)
state/
  positions.json          — managed positions (gitignored)
  pending-scan.json        — /scan candidates awaiting a button tap (gitignored)
  control.json             — auto-close enabled/disabled flag (gitignored)
  journal.jsonl             — append-only close log (gitignored)
  telegram-offset.json       — getUpdates offset (gitignored)
```

## Environment variables

- `HELIUS_RPC_URL` — Solana RPC URL (Helius preferred for `getProgramAccounts`)
- `WALLET_ADDRESS` — base58 public key whose DLMM positions are scanned/managed
- `SOLANA_PRIVATE_KEY` — base58 private key for signing withdraw/swap transactions
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — this bot's own Telegram bot
- `LOG_LEVEL` — logging level (default: info)
- `METEORA_DLMM_HOST` — override Meteora DLMM datapi host

## Notes

- Node.js ESM project (type: module)
- `@meteora-ag/dlmm` SDK is loaded via `createRequire` (same reason as
  evilpanda-screener: its CJS deps reference directories without index files)
- No GMGN dependency — MCap for the high-TVL guard comes from DexScreener's
  free public API instead, so this bot needs no API key beyond an RPC URL and
  a Telegram bot token
- Not managed by the same PM2 process as evilpanda-screener/cleobot2 — run it
  as its own pm2 app (e.g. `pm2 start index.js --name exitbot-evan`)
