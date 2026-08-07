/**
 * Indicator Exit — the third exit preset offered by the /scan picker.
 *
 * Exits on a momentum-exhaustion signal read off the pool's 15m candles
 * (GeckoTerminal OHLCV) instead of a fixed PnL% take-profit:
 *
 *   1. RSI(2) close above 90 on the 15m timeframe            (gate)
 *   AND
 *   2. MACD 15m prints its first green histogram bar (the histogram crossing
 *      up through zero — "golden cross")
 *      OR the 15m close is above the upper Bollinger Band
 *
 * Both 1 and 2 must hold on the same candle for the exit to fire.
 *
 * This replaces the take-profit trigger only — stop-loss and out-of-range
 * closes still apply to an indicator-exit position (see config.indicatorExit
 * .keepStopLoss / .keepOorClose), so the downside protection is unchanged.
 */
import { config } from "./config.js";
import { log } from "./logger.js";
import { fetchOhlcv } from "./api/geckoterminal.js";
import { rsi, macd, bollinger } from "./indicators.js";

// GeckoTerminal's free tier is 30 req/min and the exit tick runs every 15s,
// so candles are cached per pool — a 15m candle doesn't change meaningfully
// between two ticks a few seconds apart.
const ohlcvCache = new Map(); // poolAddress → { at: epochMs, candles }

async function getCandles(poolAddress, aggregate, limit) {
  const ttlMs = (config.indicatorExit?.ohlcvCacheSec ?? 60) * 1000;
  const hit = ohlcvCache.get(poolAddress);
  if (hit && Date.now() - hit.at < ttlMs) return hit.candles;

  const candles = await fetchOhlcv(poolAddress, { aggregate, limit });
  ohlcvCache.set(poolAddress, { at: Date.now(), candles });
  return candles;
}

export function clearOhlcvCache(poolAddress) {
  if (poolAddress) ohlcvCache.delete(poolAddress);
  else ohlcvCache.clear();
}

/**
 * Evaluate the Indicator Exit criteria for one pool.
 *
 * @param {string} poolAddress
 * @returns {Promise<{
 *   triggered: boolean,
 *   reason: string|null,
 *   detail: object|null,
 *   error?: string,
 * }>} — `triggered:false` with an `error` means the check couldn't run this
 *      tick (API hiccup / not enough candle history); callers must treat that
 *      as "no signal", never as "exit".
 */
export async function evaluateIndicatorExit(poolAddress) {
  const cfg = config.indicatorExit ?? {};
  const tf = cfg.timeframeMinutes ?? 15;
  const {
    rsiPeriod = 2,
    rsiThreshold = 90,
    macdFast = 12,
    macdSlow = 26,
    macdSignal = 9,
    macdCrossLookbackCandles = 1,
    bbPeriod = 20,
    bbStdDev = 2,
    useClosedCandlesOnly = true,
    candleLimit = 100,
  } = cfg;

  let candles;
  try {
    candles = await getCandles(poolAddress, tf, candleLimit);
  } catch (e) {
    return { triggered: false, reason: null, detail: null, error: `OHLCV fetch failed: ${e.message}` };
  }

  // GeckoTerminal returns newest-first — flip to oldest-first for the
  // indicator math, which is all "walk forward from the oldest bar".
  const rows = candles.slice().reverse(); // [ts, o, h, l, c, v]

  // The newest bucket is the still-forming interval whenever its timestamp is
  // inside the current one. RSI/MACD/BB are all "on close" signals, so by
  // default that bar is dropped and the last *closed* candle is evaluated.
  if (useClosedCandlesOnly && rows.length > 0) {
    const currentBucketStart = Math.floor(Date.now() / 1000 / (tf * 60)) * (tf * 60);
    if (Number(rows[rows.length - 1][0]) >= currentBucketStart) rows.pop();
  }

  const closes = rows.map((r) => Number(r[4])).filter((n) => Number.isFinite(n));
  const minBars = Math.max(macdSlow + macdSignal, bbPeriod, rsiPeriod + 1) + 1;
  if (closes.length < minBars) {
    return {
      triggered: false, reason: null, detail: null,
      error: `not enough 15m history (${closes.length} candles, need ${minBars})`,
    };
  }

  const last = closes.length - 1;
  const rsiSeries = rsi(closes, rsiPeriod);
  const { histogram } = macd(closes, macdFast, macdSlow, macdSignal);
  const { upper } = bollinger(closes, bbPeriod, bbStdDev);

  const closeNow = closes[last];
  const rsiNow = rsiSeries[last];
  const upperNow = upper[last];

  // Deadband: on a pool whose price barely moves (or doesn't move at all
  // between candles), the MACD line and its signal converge and the histogram
  // ends up at float noise — ±1e-15 — which would otherwise read as a
  // brand-new green bar every time the sign of that noise flipped. Anything
  // smaller than `histEpsilonRel` × price is treated as a flat zero.
  const histEps = closeNow * (cfg.histEpsilonRel ?? 1e-6);
  const hist = histogram.map((h) => (h == null ? null : Math.abs(h) <= histEps ? 0 : h));
  const histNow = hist[last];

  // 1 — gate.
  const rsiHit = rsiNow != null && rsiNow > rsiThreshold;

  // 2a — "first green histogram": the histogram is positive now and was <= 0
  // on the bar before the flip. `macdCrossLookbackCandles` = 1 means the flip
  // must be on the evaluated bar itself; a larger value lets a cross that
  // happened up to N bars ago still count (the histogram must have stayed
  // green the whole way).
  let macdCross = false;
  let macdCrossBarsAgo = null;
  for (let back = 0; back < Math.max(1, macdCrossLookbackCandles); back++) {
    const i = last - back;
    if (i <= 0) break;
    const cur = hist[i];
    const prev = hist[i - 1];
    if (cur == null || prev == null || !(cur > 0)) break; // not green here → no unbroken green run
    if (prev <= 0) { macdCross = true; macdCrossBarsAgo = back; break; }
  }

  // 2b — close above the upper Bollinger Band.
  const bbBreak = upperNow != null && closeNow > upperNow;

  const triggered = rsiHit && (macdCross || bbBreak);

  const detail = {
    timeframeMinutes: tf,
    candleTs: rows[last]?.[0] ?? null,
    rsi: rsiNow,
    rsiThreshold,
    rsiHit,
    histogram: histNow,
    prevHistogram: hist[last - 1],
    macdCross,
    macdCrossBarsAgo,
    close: closeNow,
    upperBand: upperNow,
    bbBreak,
  };

  if (!triggered) return { triggered: false, reason: null, detail };

  const confirmBits = [];
  if (macdCross) confirmBits.push(macdCrossBarsAgo === 0 ? "MACD first green histogram" : `MACD green histogram (${macdCrossBarsAgo} bar(s) ago)`);
  if (bbBreak) confirmBits.push(`close ${closeNow.toPrecision(6)} > upper BB ${upperNow.toPrecision(6)}`);

  return {
    triggered: true,
    reason: `Indicator Exit — RSI(${rsiPeriod}) ${rsiNow.toFixed(1)} > ${rsiThreshold} on ${tf}m & ${confirmBits.join(" & ")}`,
    detail,
  };
}

/** One-line summary for logs/status, e.g. "RSI2 94.1 · hist +0.0000012 · BB✓". */
export function summarizeIndicators(detail) {
  if (!detail) return "—";
  const rsiPart = detail.rsi == null ? "RSI —" : `RSI ${detail.rsi.toFixed(1)}${detail.rsiHit ? "✓" : ""}`;
  const macdPart = detail.histogram == null ? "MACD —" : `MACD hist ${detail.histogram >= 0 ? "+" : ""}${detail.histogram.toPrecision(3)}${detail.macdCross ? " (cross✓)" : ""}`;
  const bbPart = detail.upperBand == null ? "BB —" : `BB ${detail.bbBreak ? "break✓" : "inside"}`;
  return `${rsiPart} · ${macdPart} · ${bbPart}`;
}

export function logIndicatorState(symbol, positionAddress, detail) {
  log("manager", `${positionAddress.slice(0, 8)} (${symbol}) — indicators: ${summarizeIndicators(detail)}`);
}
