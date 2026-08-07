/**
 * Pure technical-indicator math (no I/O) for the Indicator Exit preset.
 *
 * Every function here takes `closes` **oldest-first** and returns an array of
 * the same length, with `null` in the leading positions where there isn't
 * enough history to compute a value yet. Callers read the last element for
 * "value on the most recent candle" and the second-to-last for "value on the
 * previous candle" (needed to detect the MACD histogram flipping green).
 *
 * GeckoTerminal returns candles newest-first, so reverse before calling.
 */

/**
 * Wilder-smoothed RSI — the standard formulation (same one TradingView's
 * built-in RSI uses), which matters at very short periods: RSI(2) with a
 * simple moving average of gains/losses gives noticeably different values.
 *
 * @param {number[]} closes — oldest-first
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * EMA seeded with the SMA of the first `period` values (standard seeding).
 * @param {number[]} values — oldest-first, may contain leading nulls
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);

  // Skip leading nulls (the MACD signal line is an EMA of the MACD line,
  // which itself is null until the slow EMA has enough history).
  let start = 0;
  while (start < values.length && values[start] == null) start++;
  if (values.length - start < period) return out;

  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i];
  let prev = seed / period;
  out[start + period - 1] = prev;

  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * MACD line / signal line / histogram.
 * @param {number[]} closes — oldest-first
 * @returns {{ macd: (number|null)[], signal: (number|null)[], histogram: (number|null)[] }}
 */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i],
  );
  const signal = ema(macdLine, signalPeriod);
  const histogram = closes.map((_, i) =>
    macdLine[i] == null || signal[i] == null ? null : macdLine[i] - signal[i],
  );
  return { macd: macdLine, signal, histogram };
}

/**
 * Bollinger Bands — SMA(period) ± mult × population stddev.
 * @param {number[]} closes — oldest-first
 * @returns {{ middle: (number|null)[], upper: (number|null)[], lower: (number|null)[] }}
 */
export function bollinger(closes, period = 20, mult = 2) {
  const middle = new Array(closes.length).fill(null);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { middle, upper, lower };
}
