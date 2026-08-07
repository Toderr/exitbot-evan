/**
 * exitbot-evan config — thresholds mirror evilpanda-screener's live
 * config.js (config.trader.*, checked 2026-07-11), not its README (which
 * documents an older -10%/+1% pair). If evilpanda-screener's thresholds
 * change, update here too — this bot does not import from that repo.
 */
export const config = {
  // Cron cadence for the SL/TP/OOR exit-check tick, 6-field cron (seconds first).
  cronSchedule: "*/15 * * * * *", // every 15s

  // Skip SL/TP/OOR checks for this long after a position is adopted via /scan —
  // avoids acting on a single bad/lagging datapi reading right after adoption.
  gracePeriodSec: 120,

  // Default SL/TP — same as evilpanda-screener's config.trader.
  stopLossPct: -7,      // auto-close at -7% PnL
  takeProfitPct: 0.5,   // auto-close at +0.5% PnL
  oorCloseEnabled: true, // auto-close when out of range (either direction)

  // How the SL trigger is evaluated. Independent of oorCloseEnabled above,
  // which still closes on OOR in *either* direction regardless of this.
  //   "pnl"      — SL fires only when PnL% <= stopLossPct (default, legacy behavior)
  //   "oorBelow" — SL fires as soon as price is out of range *below* the
  //                position's lower bin, regardless of PnL%
  //   "both"     — SL fires on whichever of the above happens first
  // Can be overridden per-position at adoption time (custom TP/SL flow).
  slMode: "pnl",

  // TP fires early by this fraction of the active TP target — e.g. 0.1 means
  // a 0.5% TP triggers at +0.45% instead of waiting for the exact +0.5%.
  // Scales with whatever TP is active (base/high-TVL/runner), not just the
  // default 0.5%.
  tpTolerancePct: 0.1,

  // SL only triggers after this many consecutive ticks at/below threshold —
  // filters a single anomalous datapi glitch reading (same guard as manager.js).
  slConsecutiveTicks: 2,

  // High-TVL guard: tighten TP (SL left untouched) when pool TVL exceeds this
  // % of the token's market cap (captured at /scan time via DexScreener — no
  // GMGN key needed).
  highTvl: {
    mcapPctThreshold: 20,  // TVL/MCap % that triggers tightening
    tightenedTpPct: 0.1,
  },

  // Indicator Exit preset — third option in the /scan picker (alongside
  // "default TP/SL" and "custom TP/SL"). Replaces the PnL take-profit with a
  // 15m momentum-exhaustion signal:
  //   RSI(2) close > 90  AND  (MACD first green histogram OR close > upper BB)
  // Indicator Exit only takes over the profit-taking side — SL is opt-in per
  // position (chosen at adoption time via the /scan picker, with a
  // user-chosen percent), not a global toggle here. OOR close still applies
  // unless disabled below. The high-TVL guard and runner alert never touch an
  // indicator-exit position (they only adjust TP, which is unused in this
  // mode).
  indicatorExit: {
    timeframeMinutes: 15,   // GeckoTerminal OHLCV aggregate
    rsiPeriod: 2,
    rsiThreshold: 90,       // RSI must close strictly above this (gate)
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    // 1 = the histogram must flip green on the evaluated candle itself
    // ("first green bar"). Raise it to let a cross that happened up to N
    // candles ago still count, as long as the histogram stayed green since.
    macdCrossLookbackCandles: 1,
    // Histogram values within this fraction of price are treated as zero —
    // on a barely-moving pool the raw histogram lands on float noise (±1e-15)
    // whose sign flips would otherwise read as fresh "first green" bars.
    histEpsilonRel: 1e-6,
    bbPeriod: 20,
    bbStdDev: 2,
    // Evaluate the last *closed* 15m candle. The still-forming bucket is
    // dropped — RSI/MACD/BB are all close-based signals, and an in-progress
    // bar flip-flops. Set false to react to the forming candle instead.
    useClosedCandlesOnly: true,
    candleLimit: 100,       // enough history for MACD(26,9) + BB(20)
    ohlcvCacheSec: 60,      // per-pool candle cache (GeckoTerminal: 30 req/min)
    keepOorClose: true,     // OOR still closes an indicator-exit position
  },

  // Give up auto-closing a position after this many consecutive withdraw
  // failures — surfaced to Telegram, must be closed manually after that.
  maxCloseFailures: 4,

  // Priority fee for the withdraw (removeLiquidity) transaction. The DLMM SDK
  // builds this tx with no priority fee at all, so under network congestion it
  // can sit unconfirmed until its blockhash expires (~60-90s) and has to be
  // retried from scratch — this is what made withdrawals slow/appear stuck.
  // Fetched dynamically per attempt from Helius's getPriorityFeeEstimate,
  // clamped to [floorMicroLamports, capMicroLamports]; falls back to the floor
  // if the estimate call fails or the RPC doesn't support the method.
  withdrawPriorityFee: {
    floorMicroLamports: 20_000,
    capMicroLamports: 1_000_000,
  },

  // Watchdog for the 15s cron tick. A legitimate close (withdraw retries +
  // swap fallback retries) can take up to a couple minutes, so this must sit
  // above that — but a tick stuck past this is treated as hung (e.g. an RPC
  // call that never resolves) and force-recovered so the cron isn't blocked
  // forever. See index.js.
  tickWatchdogMs: 240_000, // 4 min

  stateFile: "./state/positions.json",
  journalFile: "./state/journal.jsonl",
  pendingScanFile: "./state/pending-scan.json",
  awaitingCustomFile: "./state/awaiting-custom.json",
};
