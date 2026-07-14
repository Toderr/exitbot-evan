/**
 * GeckoTerminal OHLCV client — per-pool candles for Solana DEXes.
 *
 * Host: https://api.geckoterminal.com/api/v2
 * Auth: none
 * Rate: 30 req/min free tier
 * Docs: https://apiguide.geckoterminal.com/
 */

const HOST = "https://api.geckoterminal.com/api/v2";

/**
 * Fetch OHLCV candles for a Solana pool.
 *
 * @param {string} poolAddress
 * @param {object} [opts]
 * @param {number} [opts.aggregate] — 1 | 5 | 15 | 30 | 60 | 240 | 1440 (minutes)
 * @param {number} [opts.limit]     — up to 1000
 * @returns {Promise<Array<[number, number, number, number, number, number]>>}
 *          — newest-first: [timestamp_sec, open, high, low, close, volume]
 */
export async function fetchOhlcv(poolAddress, { aggregate = 15, limit = 30 } = {}) {
  const url = `${HOST}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=${aggregate}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal ohlcv ${res.status} ${res.statusText}`);
  const body = await res.json();
  return body?.data?.attributes?.ohlcv_list ?? [];
}

/**
 * Fetch the pool's latest candle at or before `beforeTimestamp` (UNIX seconds).
 * The close of that candle approximates price at `beforeTimestamp`.
 *
 * GeckoTerminal only returns candles where trades happened, so the candle
 * returned may be slightly older than requested for low-activity periods.
 *
 * @param {string} poolAddress
 * @param {number} beforeTimestamp — UNIX seconds
 * @param {number} [aggregate]     — 1 | 5 | 15 | 30 | 60 | 240 | 1440 (minutes)
 * @returns {Promise<{ timestamp: number, close: number } | null>}
 */
export async function fetchOhlcvBefore(poolAddress, beforeTimestamp, aggregate = 1) {
  const url = `${HOST}/networks/solana/pools/${poolAddress}/ohlcv/minute`
    + `?aggregate=${aggregate}&limit=1&before_timestamp=${beforeTimestamp}`;
  // Simple retry on 429 — GeckoTerminal free tier is 30 req/min.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`GeckoTerminal ohlcv (before) ${res.status} ${res.statusText}`);
    const body = await res.json();
    const rows = body?.data?.attributes?.ohlcv_list ?? [];
    if (rows.length === 0) return null;
    const [ts, , , , close] = rows[0];
    return { timestamp: ts, close };
  }
  throw new Error("GeckoTerminal ohlcv (before) 429 after retries");
}

/**
 * Fetch the current USD price of a Solana token.
 * @returns {Promise<number|null>}
 */
export async function fetchTokenPriceUsd(mint) {
  const url = `${HOST}/simple/networks/solana/token_price/${mint}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal token_price ${res.status} ${res.statusText}`);
  const body = await res.json();
  const raw = body?.data?.attributes?.token_prices?.[mint];
  const n = raw != null ? Number(raw) : null;
  return Number.isFinite(n) ? n : null;
}
