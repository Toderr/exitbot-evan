/**
 * DexScreener public API — used only to get a token's market cap at /scan
 * time, for the high-TVL guard (tightens TP/SL when pool TVL is large
 * relative to MCap). No API key required. Non-fatal on failure — the guard
 * simply doesn't tighten if MCap can't be determined.
 */
const HOST = "https://api.dexscreener.com";

export async function fetchMarketCap(mint) {
  try {
    const res = await fetch(`${HOST}/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const body = await res.json();
    const pairs = body?.pairs ?? [];
    if (pairs.length === 0) return null;
    // Prefer the pair with the highest liquidity — most representative price/mcap.
    const best = pairs.reduce((a, b) =>
      Number(b?.liquidity?.usd ?? 0) > Number(a?.liquidity?.usd ?? 0) ? b : a
    );
    const mcap = Number(best?.marketCap ?? best?.fdv);
    return Number.isFinite(mcap) && mcap > 0 ? mcap : null;
  } catch {
    return null;
  }
}
