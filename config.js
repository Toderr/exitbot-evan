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

  // Give up auto-closing a position after this many consecutive withdraw
  // failures — surfaced to Telegram, must be closed manually after that.
  maxCloseFailures: 4,

  stateFile: "./state/positions.json",
  controlFile: "./state/control.json",
  journalFile: "./state/journal.jsonl",
  pendingScanFile: "./state/pending-scan.json",
  awaitingCustomFile: "./state/awaiting-custom.json",
};
