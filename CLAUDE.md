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
3. Tapping a position offers three **exit presets**: default TP/SL, custom
   TP/SL (type `TP SL [slMode]`), or **📈 Indicator Exit** — see below.
4. Every 15 seconds (`config.cronSchedule`), for each *managed* position:
   fetch PnL/range from the Meteora datapi (`fetchDlmmPnl`), apply the
   high-TVL guard, and check SL/TP/OOR. On trigger: withdraw the position,
   swap the token side to SOL (Jupiter, Meteora fallback), log to
   `state/journal.jsonl`, remove from state, and notify Telegram. If the
   datapi stops reporting a managed position as open for 2 consecutive
   ticks, the bot double-checks the position account on-chain
   (`positionAccountExists`) — if it's genuinely gone (e.g. closed manually
   outside the bot), it's auto-forgotten with a Telegram notification
   instead of being silently checked forever.
5. `/scan` again any time you open a new position manually — it'll show up
   as a new button (already-managed ones won't re-appear).

No continuous RPC polling happens outside of a `/scan` call or a managed
position's 15s PnL check — this bot never touches positions you haven't
explicitly told it about.

## Thresholds (`config.js`)

Mirrors evilpanda-screener's live `config.trader.*` (checked 2026-07-11, not
its older README figures):
- SL: -7% PnL
- TP: +0.5% PnL
- OOR *above* always auto-closes (favorable break, independent of SL mode).
  OOR *below* only auto-closes when SL mode is `"oorBelow"` or `"both"`
  (i.e. it's an explicit SL trigger) — for plain `"pnl"` mode (and Indicator
  Exit), an OOR-below break sends a one-time Telegram alert instead and
  leaves the position open, relying on the PnL threshold (or the indicator
  signal) to decide the actual close.
- SL mode (`config.slMode`, default `"pnl"`, overridable per-position via the
  /scan custom TP/SL flow): `"pnl"` fires SL only on PnL% ≤ threshold (legacy
  default); `"oorBelow"` fires SL as soon as price is out of range *below*
  the position's lower bin, regardless of PnL%; `"both"` fires on whichever
  hits first
- SL requires 2 consecutive 15s ticks at/below threshold (datapi glitch filter,
  applies to whichever condition slMode is evaluating)
- OOR-below grace (`config.oorCloseDurationSec`, default `0`): only relevant
  when SL mode is `"oorBelow"`/`"both"` (the only case OOR-below is a close
  trigger at all — see above). `0` closes the instant the range breaks (old
  default); a longer duration waits that many seconds of sustained OOR-below
  before actually closing, instead of closing on the first break. Set
  per-position in the /scan custom TP/SL flow, right after picking
  `oorbelow`/`both` as the SL mode (preset buttons for 5m/15m/1h, or a custom
  number of minutes). OOR-above is never subject to this — always instant.
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

## Indicator Exit preset (`config.indicatorExit`)

Third option in the /scan picker, alongside default and custom TP/SL. It
**replaces the PnL take-profit** with a 15m momentum-exhaustion signal read
off GeckoTerminal OHLCV — both conditions must hold on the same candle:

1. **Gate** — RSI(2) on the 15m timeframe closes above 90 (Wilder smoothing,
   the same formulation TradingView uses; at period 2 the smoothing choice
   changes the number materially).
2. **AND** either:
   - MACD(12,26,9) on 15m prints its *first green histogram bar* — the
     histogram crossing up through zero ("golden cross"), or
   - the 15m close is above the upper Bollinger Band (20, 2σ).

After picking Indicator Exit, the bot asks whether to add a Stop Loss —
declining leaves the indicator as the sole exit trigger (besides OOR);
accepting prompts for the SL percent as a plain-text reply (e.g. `-6` for
-6% PnL), stored per position, not a global config value.

Notes:
- **SL is opt-in per position, OOR-above still applies** (OOR-below alerts
  rather than closes, same as any other `"pnl"`-mode position — see above).
  Turn OOR off entirely for this mode with `indicatorExit.keepOorClose` if you
  want the indicator (plus your chosen SL, if any) to be the sole exit.
- The high-TVL guard and runner alert never touch an indicator-exit position
  (both only adjust TP, which is unused here).
- Only the last **closed** 15m candle is evaluated — the still-forming bucket
  is dropped (`useClosedCandlesOnly`), since RSI/MACD/BB are close-based and
  an in-progress bar flip-flops. Set it to `false` to react to the forming
  candle instead.
- `macdCrossLookbackCandles` (default 1) means the histogram must flip green
  on the evaluated bar itself. Raise it to let a cross from up to N bars ago
  still count, provided the histogram stayed green since.
- Histogram values within `histEpsilonRel` × price (default 1e-6) are treated
  as zero — on a barely-moving pool the raw histogram sits on float noise
  (±1e-15) whose sign flips would otherwise read as fresh "first green" bars.
- Candles are cached per pool for `ohlcvCacheSec` (60s) — the tick runs every
  15s and GeckoTerminal's free tier allows 30 req/min.
- Positions adopted before this preset existed have no `exitMode` field and
  are treated as `"pnl"` — behavior unchanged.

## Telegram commands

| Command | Effect |
|---|---|
| `/scan` | Enumerate wallet on-chain, show a button per new SOL-quoted position (one per position, not per pool) to pick which to manage, then pick its exit preset (default TP/SL · custom TP/SL · Indicator Exit) |
| `/status` | List currently managed positions + their TP/SL |
| `/stop` | Show a picker: stop managing one specific position, or "Stop ALL" to stop managing every currently managed position (each left untouched on-chain) — the bot itself and its 15s cron keep running |
| `/forget <positionAddress>` | Stop managing a position directly by address (does not close it on-chain) |
| `/help` | Show command list |

Only `TELEGRAM_CHAT_ID` is honored — other chats are ignored (this bot signs
transactions).

## Architecture

```
index.js              — entry point (listener + 15s cron)
config.js              — thresholds
manager.js              — /scan candidate discovery, adoption, snapshot, high-TVL guard, SL/TP/OOR close
indicators.js            — pure RSI / EMA / MACD / Bollinger math (no I/O)
indicatorExit.js          — Indicator Exit preset: 15m candle fetch + cache, criteria evaluation
telegramListener.js     — command + inline-keyboard long-poll (/scan picker, /status /stop /forget /help)
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
