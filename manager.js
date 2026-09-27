/**
 * exitbot-evan core — SL/TP/OOR auto-close for manually-managed Meteora DLMM
 * positions, ported from evilpanda-screener's manager.js exit logic.
 *
 * Unlike evilpanda-screener's manager, this bot has no trader/screener behind
 * it, so it doesn't discover positions on a timer. Positions are adopted only
 * when the user sends /scan — that does a single on-chain enumeration
 * (fetchUserPositions) and adds any not-yet-tracked position to
 * state/positions.json. From then on, the 15s cron tick in index.js checks
 * SL/TP/OOR for whatever is in that file, using the Meteora datapi
 * (fetchDlmmPnl) for PnL/range — no further on-chain scanning happens until
 * the next /scan.
 *
 * State is keyed by positionAddress, not poolAddress — a wallet can (and
 * often does) hold more than one DLMM position in the same pool, and each
 * must be tracked/closed independently.
 */
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { log } from "./logger.js";
import {
  fetchUserPositions,
  fetchDlmmPnl,
  fetchPoolInfo,
  withdrawPosition,
  swapTokenToSolViaMeteora,
  positionAccountExists,
  rebalancePositionOneSidedQuote,
  QUOTE_MINTS,
} from "./api/meteora.js";
import { swapAllToSolFromKey, getTokenBalanceFromKey } from "./api/jupiter.js";
import { fetchMarketCap } from "./api/dexscreener.js";
import { fetchOhlcv } from "./api/geckoterminal.js";
import { evaluateIndicatorExit, summarizeIndicators } from "./indicatorExit.js";
import bot from "./telegram.js";
import { renderPnlCard } from "./pnlCard.js";
import { card } from "./richCard.js";

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function fmtUsd(n) { return n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`; }
function fmtPct(n) { return n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`; }

function row(label, detail) {
  return [label, detail];
}

// ─── State ──────────────────────────────────────────────────────────────────

function loadPositions() {
  if (!fs.existsSync(config.stateFile)) return {};
  try { return JSON.parse(fs.readFileSync(config.stateFile, "utf8")); }
  catch (e) { log("manager_warn", `positions state corrupt — starting fresh: ${e.message}`); return {}; }
}

function savePositions(positions) {
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify(positions, null, 2));
}

function appendJournal(entry) {
  try {
    fs.mkdirSync(path.dirname(config.journalFile), { recursive: true });
    fs.appendFileSync(config.journalFile, JSON.stringify({ ...entry, ts: Math.floor(Date.now() / 1000) }) + "\n");
  } catch (e) {
    log("manager_warn", `journal write failed: ${e.message}`);
  }
}

// SL only triggers after N consecutive ticks at/below threshold — filters a
// single anomalous datapi glitch (in-memory only; resets on restart, matching
// evilpanda-screener's manager.js behavior).
const slBelowCount = new Map(); // positionAddress → count

// A position missing from the datapi's open-positions response for N
// consecutive ticks (filters a single stale-datapi blip) triggers an
// on-chain existence check — if the account is truly gone (closed manually
// or otherwise, outside this bot), it's auto-forgotten with a notification
// instead of being checked for SL/TP forever.
const missingCount = new Map(); // positionAddress → count
const MISSING_CONSECUTIVE_TICKS = 2;

// ─── /scan — enumerate on-chain positions, let the user pick which to manage ─
// Two-step flow: /scan finds candidates and stores them in
// state/pending-scan.json (nothing is managed yet); the user then taps a
// Telegram button (or /forget-style command) to adopt one, several, or all.
// Candidates found again on a later /scan (still untracked) just refresh the
// pending entry — no duplicate buttons pile up across scans. Every open
// position is listed individually, even when two positions share a pool.

function loadPending() {
  if (!fs.existsSync(config.pendingScanFile)) return {};
  try { return JSON.parse(fs.readFileSync(config.pendingScanFile, "utf8")); }
  catch { return {}; }
}

function savePending(pending) {
  fs.mkdirSync(path.dirname(config.pendingScanFile), { recursive: true });
  fs.writeFileSync(config.pendingScanFile, JSON.stringify(pending, null, 2));
}

// Infer the deposit shape (Spot/Curve/Bid-Ask) from per-bin liquidity, since
// it isn't stored anywhere after the fact — heuristic, not authoritative.
//
// A single-sided/skewed position (deposited mostly or entirely on one side of
// the entry price, common for a manually-opened position) produces a
// monotonic ramp in per-bin liquidity, not a symmetric bowl or bump. The
// naive "average the two outer thirds vs the middle third" test used to be
// the *whole* algorithm, and it has a blind spot there: for any perfectly
// linear sequence, the average of the two outer thirds combined is
// mathematically equal to the average of the middle third (that's just what
// a straight line's mean does), so a real Bid-Ask deposit skewed to one side
// always read as flat under that test alone — confirmed against a live
// position whose per-bin liquidity was a near-perfect linear ramp down to
// zero, misclassified as "Spot (flat)".
//
// Fix: fit a straight line through the per-bin liquidity first. A strong,
// near-perfect linear trend (R² close to 1) *is* an edge-weighted deposit,
// just skewed to one side rather than symmetric — Meteora's Bid-Ask weight
// is distance-from-center-based, which collapses to one straight segment
// when the position only covers one side of that center. Only when the data
// isn't well explained by a line do we fall back to comparing outer-thirds
// vs middle-third — now on the *residual* after removing that line, so a
// sloped-but-curved deposit (a skewed Curve, or a two-sided Bid-Ask/Curve
// whose center isn't exactly mid-range) isn't swallowed by its own trend.
function classifyShape(positionBinData) {
  const bins = (positionBinData ?? []).slice().sort((a, b) => a.binId - b.binId);
  if (bins.length < 5) return "Spot";

  // Values run up to ~1e27+ (raw on-chain liquidity units) — Number loses
  // precision at that magnitude but shape classification only needs relative
  // proportions, not exact amounts, so the precision loss doesn't matter here.
  const liq = bins.map((b) => {
    try { return Number(BigInt(b.positionLiquidity || "0")); } catch { return 0; }
  });
  const n = liq.length;
  const maxLiq = Math.max(...liq);
  const minLiq = Math.min(...liq);
  if (maxLiq <= 0 || (maxLiq - minLiq) / maxLiq < 0.1) return "Spot (flat)";

  // Least-squares line through (bin index, liquidity).
  const meanX = (n - 1) / 2;
  const meanY = liq.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    sxy += dx * (liq[i] - meanY);
    sxx += dx * dx;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const fitted = liq.map((_, i) => intercept + slope * i);
  const rampSpan = Math.abs(slope) * (n - 1); // total rise/fall the fitted line implies

  const residual = liq.map((v, i) => v - fitted[i]);
  const third = Math.max(1, Math.floor(n / 3));
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const edgeAvg = avg([...residual.slice(0, third), ...residual.slice(-third)]);
  const midAvg = avg(residual.slice(third, n - third));
  const scale = maxLiq - minLiq;

  if (edgeAvg - midAvg > scale * 0.08) return "Bid-Ask (edge-weighted)";
  if (midAvg - edgeAvg > scale * 0.08) return "Curve (center-weighted)";
  if (rampSpan / maxLiq > 0.3) return "Bid-Ask (edge-weighted, single-sided ramp)";
  return "Spot (flat)";
}

// Historical total deposit (SOL/USD) for one position, from the Meteora
// datapi's allTimeDeposits — the closest thing to "how much did I put in",
// as opposed to totalXAmount/totalYAmount which is the current live balance.
// Non-fatal: returns nulls if the datapi hasn't indexed this position yet.
async function fetchPositionDeposit(poolAddress, walletAddress, positionAddress) {
  try {
    const pnlData = await fetchDlmmPnl(poolAddress, walletAddress);
    const match = (pnlData?.positions ?? []).find((p) => p.positionAddress === positionAddress);
    if (!match) return { depositSol: null, depositUsd: null };
    return {
      depositSol: Number(match.allTimeDeposits?.total?.sol ?? null) || null,
      depositUsd: Number(match.allTimeDeposits?.total?.usd ?? null) || null,
    };
  } catch {
    return { depositSol: null, depositUsd: null };
  }
}

export async function scanOnChain(rpcUrl, walletAddress) {
  const onChain = await fetchUserPositions(rpcUrl, walletAddress);
  const positions = loadPositions();
  const pending = {};
  const candidates = [];
  const alreadyTracked = [];
  let totalPositions = 0;

  for (const pool of onChain) {
    if (pool.quoteMint !== QUOTE_MINTS.SOL) {
      log("manager", `Scan: skip pool ${pool.poolAddress.slice(0, 8)} — quote is not SOL`);
      continue;
    }

    let symbol = pool.baseMint.slice(0, 6);
    try {
      const info = await fetchPoolInfo(pool.poolAddress);
      if (info?.name) symbol = info.name;
    } catch { /* non-fatal — fall back to mint prefix */ }

    for (const pos of pool.positions ?? []) {
      if (!pos?.publicKey) continue;
      totalPositions++;

      if (positions[pos.publicKey]) {
        alreadyTracked.push(positions[pos.publicKey]);
        continue;
      }

      const { depositSol, depositUsd } = await fetchPositionDeposit(pool.poolAddress, walletAddress, pos.publicKey);

      const candidate = {
        poolAddress: pool.poolAddress,
        positionAddress: pos.publicKey,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        symbol,
        lowerBinId: pos.lowerBinId,
        upperBinId: pos.upperBinId,
        binCount: pos.upperBinId - pos.lowerBinId + 1,
        shape: classifyShape(pos.positionBinData),
        depositSol,
        depositUsd,
      };
      pending[pos.publicKey] = candidate;
      candidates.push(candidate);
    }
  }

  savePending(pending);
  return { candidates, alreadyTracked, totalPositions, totalPools: onChain.length };
}

// Adopt one previously-scanned candidate into management (called from a
// Telegram button tap). `overrides` optionally sets custom TP/SL instead of
// config defaults — used when the user picks "Set Custom TP/SL" instead of
// "Use Default" during the /scan picker flow — or `exitMode: "indicator"` for
// the Indicator Exit preset, which replaces the PnL take-profit with the 15m
// RSI/MACD/Bollinger signal (see indicatorExit.js). For indicator mode, SL is
// opt-in per position: `overrides.indicatorSlEnabled` (bool) plus
// `overrides.stopLossPct` (the percent, only read when enabled) — unlike pnl
// mode, where SL always applies at either a custom or config-default percent.
// Returns the new entry, or null if it's no longer pending.
export async function adoptCandidate(positionAddress, overrides = {}) {
  const pending = loadPending();
  const candidate = pending[positionAddress];
  if (!candidate) return null;

  const entryMcap = await fetchMarketCap(candidate.baseMint).catch(() => null);
  const exitMode = overrides.exitMode === "indicator" ? "indicator" : "pnl";
  const isIndicator = exitMode === "indicator";

  const slEnabled = isIndicator ? overrides.indicatorSlEnabled === true : true;
  const stopLossPct = isIndicator
    ? (slEnabled && Number.isFinite(overrides.stopLossPct) ? overrides.stopLossPct : null)
    : (Number.isFinite(overrides.stopLossPct) ? overrides.stopLossPct : config.stopLossPct);

  const entry = {
    poolAddress: candidate.poolAddress,
    positionAddress: candidate.positionAddress,
    baseMint: candidate.baseMint,
    quoteMint: candidate.quoteMint,
    symbol: candidate.symbol,
    lowerBinId: candidate.lowerBinId,
    upperBinId: candidate.upperBinId,
    binCount: candidate.binCount,
    shape: candidate.shape,
    depositSol: candidate.depositSol,
    depositUsd: candidate.depositUsd,
    adoptedAt: Math.floor(Date.now() / 1000),
    // baseTakeProfitPct/baseStopLossPct are the user's intended normal
    // thresholds (custom or default) — the high-TVL guard tightens
    // takeProfitPct/stopLossPct temporarily but reverts to these, not to
    // config's global defaults, so a custom TP/SL survives a guard cycle.
    // Unused for indicator-mode TP (that guard skips indicator positions).
    takeProfitPct: Number.isFinite(overrides.takeProfitPct) ? overrides.takeProfitPct : config.takeProfitPct,
    stopLossPct,
    baseTakeProfitPct: Number.isFinite(overrides.takeProfitPct) ? overrides.takeProfitPct : config.takeProfitPct,
    baseStopLossPct: stopLossPct,
    slMode: isIndicator ? "pnl" : (["pnl", "oorBelow", "both"].includes(overrides.slMode) ? overrides.slMode : config.slMode),
    // "pnl" (default/custom TP/SL) or "indicator" (15m RSI/MACD/BB signal
    // replaces the take-profit; SL/OOR unchanged).
    exitMode,
    // Whether SL is active at all — always true for pnl mode; a per-position
    // opt-in choice for indicator mode (stopLossPct is null when declined).
    slEnabled,
    customTpSl: !isIndicator && (Number.isFinite(overrides.takeProfitPct) || Number.isFinite(overrides.stopLossPct)),
    entryMcap,
    highTvlMode: false,
    runnerMode: false,
    touchedMinus5: false,
    // Indicator Exit + no SL: tracks whether the "price broke below range"
    // alert has already fired for the current below-range episode, so it
    // doesn't re-send every 15s tick — resets once price is back in range.
    oorBelowAlerted: false,
    // How long an OOR-below break must persist (slMode "oorBelow"/"both"
    // only — that's the only case OOR-below is a close trigger at all, see
    // oorBelowHandledBySl in runExitCheck) before it actually closes, instead
    // of closing the instant it's broken. User-chosen at adoption time via
    // the /scan picker's OOR-duration step; 0 = close immediately (old
    // default). OOR-above never waits on this — it's always an instant
    // close, favorable break, no reason to hold off.
    oorCloseDurationSec: Number.isFinite(overrides.oorCloseDurationSec) ? overrides.oorCloseDurationSec : (config.oorCloseDurationSec ?? 0),
    oorSince: null, // timestamp the current OOR-below-as-trigger episode started, or null
    closeFailCount: 0,
  };

  const positions = loadPositions();
  positions[positionAddress] = entry;
  savePositions(positions);

  delete pending[positionAddress];
  savePending(pending);

  log("manager", `Adopted ${positionAddress.slice(0, 8)} in pool ${entry.poolAddress.slice(0, 8)} (${entry.symbol})`);
  return entry;
}

export function listPending() {
  return Object.values(loadPending());
}

export function getPendingCandidate(positionAddress) {
  return loadPending()[positionAddress] ?? null;
}

// ─── Awaiting-custom-reply state ──────────────────────────────────────────
// Single-slot: this is a one-user DM bot, so only one "waiting for the user
// to type a number" prompt is ever outstanding at a time. `kind` distinguishes
// which flow the next plain-text reply belongs to — "customTpSl" (TP+SL for
// the default/custom preset) or "indicatorSl" (just an SL percent, for the
// Indicator Exit preset's opt-in stop loss).
export function setAwaitingCustom(positionAddress, kind = "customTpSl") {
  fs.mkdirSync(path.dirname(config.awaitingCustomFile), { recursive: true });
  fs.writeFileSync(config.awaitingCustomFile, JSON.stringify({ positionAddress, kind }));
}

export function getAwaitingCustom() {
  if (!fs.existsSync(config.awaitingCustomFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(config.awaitingCustomFile, "utf8"));
    if (!data?.positionAddress) return null;
    return { positionAddress: data.positionAddress, kind: data.kind ?? "customTpSl" };
  } catch { return null; }
}

export function clearAwaitingCustom() {
  try { fs.unlinkSync(config.awaitingCustomFile); } catch { /* already gone */ }
}

// ─── Awaiting-OOR-duration state ──────────────────────────────────────────
// Single-slot, same reasoning as awaiting-custom above. Holds the exit-preset
// overrides already collected (default/custom TP-SL or indicator settings)
// while the /scan flow asks its final question — how long an OOR-below
// break should be tolerated before auto-closing — so they can be merged
// into one adoptCandidate() call once that's answered.
export function setAwaitingOor(positionAddress, overrides = {}) {
  fs.mkdirSync(path.dirname(config.awaitingOorFile), { recursive: true });
  fs.writeFileSync(config.awaitingOorFile, JSON.stringify({ positionAddress, overrides }));
}

export function getAwaitingOor() {
  if (!fs.existsSync(config.awaitingOorFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(config.awaitingOorFile, "utf8"));
    if (!data?.positionAddress) return null;
    return data;
  } catch { return null; }
}

export function clearAwaitingOor() {
  try { fs.unlinkSync(config.awaitingOorFile); } catch { /* already gone */ }
}

export function listManaged() {
  return Object.values(loadPositions());
}

export function forget(positionAddress) {
  const positions = loadPositions();
  if (!positions[positionAddress]) return false;
  delete positions[positionAddress];
  savePositions(positions);
  return true;
}

// ─── /rebalance — recenter a managed position's liquidity to current price ──
// User-triggered only (never run by the 15s cron). Withdraws 100% of the
// position's liquidity + fees and redeposits — quote (SOL) side only, in a
// range strictly below the current active bin — see
// api/meteora.js:rebalancePositionOneSidedQuote. Same position address, so
// SL/TP config carries over unchanged; only the range/deposit/grace-period
// fields are refreshed to reflect the new liquidity.
//
// `params.shape` ("Spot"|"Curve"|"BidAsk"), `params.rangeBins` (positive
// int bin width), and `params.depositSol` (SOL amount, or null/undefined to
// redeposit everything withdrawn) are all asked interactively in the
// /rebalance Telegram flow — see setAwaitingRebalance below.
export async function rebalanceEntry(positionAddress, params) {
  const positions = loadPositions();
  const entry = positions[positionAddress];
  if (!entry) return { ok: false, error: "Position is not currently managed." };

  const strategy = params.shape;
  const rangeBins = params.rangeBins;
  const maxActiveBinSlippage = config.rebalance?.maxActiveBinSlippage ?? 3;
  const depositLamports = params.depositSol != null ? String(Math.round(params.depositSol * 1e9)) : null;

  const result = await rebalancePositionOneSidedQuote(
    process.env.HELIUS_RPC_URL,
    process.env.SOLANA_PRIVATE_KEY,
    entry.poolAddress,
    { publicKey: positionAddress },
    { strategy, rangeBins, depositLamports, maxActiveBinSlippage },
  );

  entry.lowerBinId = result.lowerBinId;
  entry.upperBinId = result.upperBinId;
  entry.binCount = result.upperBinId - result.lowerBinId + 1;
  entry.shape = `${strategy} (one-side quote, rebalanced)`;
  // Fresh grace period — the position's PnL/range are effectively reset by
  // the withdraw+redeposit, so don't evaluate SL/TP against it immediately.
  entry.adoptedAt = Math.floor(Date.now() / 1000);
  entry.highTvlMode = false;
  entry.runnerMode = false;
  entry.touchedMinus5 = false;
  entry.oorBelowAlerted = false;
  entry.oorSince = null;
  entry.closeFailCount = 0;
  entry.takeProfitPct = entry.baseTakeProfitPct ?? config.takeProfitPct;

  const { depositSol, depositUsd } = await fetchPositionDeposit(entry.poolAddress, process.env.WALLET_ADDRESS, positionAddress).catch(() => ({ depositSol: null, depositUsd: null }));
  if (depositSol != null || depositUsd != null) {
    entry.depositSol = depositSol;
    entry.depositUsd = depositUsd;
  }

  positions[positionAddress] = entry;
  savePositions(positions);
  slBelowCount.delete(positionAddress);
  missingCount.delete(positionAddress);

  log("manager", `Rebalanced ${positionAddress.slice(0, 8)} (${entry.symbol}) → bins ${entry.lowerBinId}-${entry.upperBinId}, deposited ${(Number(result.depositedLamports) / 1e9).toFixed(4)} SOL`);
  return { ok: true, entry, sigs: result.sigs, depositedSol: Number(result.depositedLamports) / 1e9 };
}

// ─── Awaiting-rebalance-reply state ───────────────────────────────────────
// Single-slot, same reasoning as awaiting-custom above (one-user DM bot).
// Walks: shape (button tap, not stored here) → rangeBins (text) →
// depositSol (text) → confirm (button tap, reads the accumulated data).
export function setAwaitingRebalance(positionAddress, step, data = {}) {
  fs.mkdirSync(path.dirname(config.awaitingRebalanceFile), { recursive: true });
  fs.writeFileSync(config.awaitingRebalanceFile, JSON.stringify({ positionAddress, step, ...data }));
}

export function getAwaitingRebalance() {
  if (!fs.existsSync(config.awaitingRebalanceFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(config.awaitingRebalanceFile, "utf8"));
    if (!data?.positionAddress || !data?.step) return null;
    return data;
  } catch { return null; }
}

export function clearAwaitingRebalance() {
  try { fs.unlinkSync(config.awaitingRebalanceFile); } catch { /* already gone */ }
}

// ─── Snapshot (PnL/OOR from Meteora datapi) ──────────────────────────────────

async function buildSnapshot(entry, walletAddress) {
  let pnlUsd = null, pnlSol = null, pnlPct = null;
  let feesUsd = null, unclaimedFeesUsd = null, claimedFeesUsd = null;
  let oor = false, oorBelow = false, oorAbove = false;
  let _positions = [];

  const pnlData = await fetchDlmmPnl(entry.poolAddress, walletAddress);
  const allPositions = pnlData?.positions ?? [];
  // Filter to just this position — a pool can hold more than one of the
  // wallet's positions, and each is managed (and closed) independently.
  const positions = allPositions.filter((p) => p.positionAddress === entry.positionAddress);

  if (allPositions.length > 0 && positions.length === 0) {
    log("manager_warn", `${entry.positionAddress.slice(0, 8)}: datapi returned ${allPositions.length} position(s) in pool ${entry.poolAddress.slice(0, 8)} but none match — stale datapi, skipping PnL`);
  }

  _positions = positions.map((p) => ({
    publicKey: p.positionAddress,
    lowerBinId: p.lowerBinId,
    upperBinId: p.upperBinId,
  }));

  if (positions.length > 0) {
    // Re-price the tokenX side using the pool's active price when available —
    // the datapi occasionally undervalues thin positions' non-SOL side (same
    // fix as evilpanda-screener's manager.js).
    pnlUsd = positions.reduce((s, p) => s + Number(p.pnlUsd ?? 0), 0);
    pnlSol = positions.reduce((s, p) => {
      const ap = Number(p.poolActivePrice ?? 0);
      if (!(ap > 0)) return s + Number(p.pnlSol ?? 0);
      const u = p.unrealizedPnl ?? {};
      const value =
        Number(u.balanceTokenY?.amountSol ?? 0) +
        Number(u.balanceTokenX?.amount ?? 0) * ap +
        Number(u.unclaimedFeeTokenY?.amountSol ?? 0) +
        Number(u.unclaimedFeeTokenX?.amount ?? 0) * ap +
        Number(p.allTimeFees?.total?.sol ?? 0) +
        Number(p.allTimeWithdrawals?.total?.sol ?? 0);
      return s + (value - Number(p.allTimeDeposits?.total?.sol ?? 0));
    }, 0);

    const totalDepositSol = positions.reduce((s, p) => s + Number(p.allTimeDeposits?.total?.sol ?? 0), 0);
    const totalDepositUsd = positions.reduce((s, p) => s + Number(p.allTimeDeposits?.total?.usd ?? 0), 0);
    if (totalDepositSol > 0) {
      pnlPct = (pnlSol / totalDepositSol) * 100;
    } else if (totalDepositUsd > 0) {
      pnlPct = (pnlUsd / totalDepositUsd) * 100;
    }

    claimedFeesUsd = positions.reduce((s, p) => s + Number(p.allTimeFees?.total?.usd ?? 0), 0);
    unclaimedFeesUsd = positions.reduce((s, p) =>
      s + Number(p.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0)
        + Number(p.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0), 0);
    feesUsd = claimedFeesUsd + unclaimedFeesUsd;

    oor = positions.every((p) => p.isOutOfRange === true);
    // Direction of OOR — "below" means the active bin has dropped under the
    // position's lower bin (price fell through the bottom of the range),
    // "above" means it rose past the upper bin. Used by slMode: "oorBelow"/"both"
    // to trigger SL specifically on the downside, independent of PnL%.
    oorBelow = oor && positions.every((p) => Number(p.poolActiveBinId) < Number(p.lowerBinId));
    oorAbove = oor && positions.every((p) => Number(p.poolActiveBinId) > Number(p.upperBinId));
  }

  return { oor, oorBelow, oorAbove, pnlUsd, pnlSol, pnlPct, feesUsd, unclaimedFeesUsd, claimedFeesUsd, _positions, matched: positions.length > 0 };
}

// ─── High-TVL guard ──────────────────────────────────────────────────────────
// Tighten TP when pool TVL exceeds `mcapPctThreshold`% of the token's MCap
// (captured at /scan time) — a large pool relative to a small token's MCap is
// a rug/dump risk sign, so profit gets locked in sooner. SL is left untouched.
// Skipped entirely for positions with a custom TP/SL (entry.customTpSl) — same
// rule as the runner alert: a deliberate custom TP/SL isn't silently overridden.

async function applyHighTvlGuard(entry, poolData) {
  if (entry.customTpSl) return;
  if (entry.exitMode === "indicator") return; // no TP to tighten in this mode
  if (!(entry.entryMcap > 0)) return; // no MCap reference — guard can't evaluate

  const poolTvl = Number(poolData?.tvl) || null;
  if (poolTvl == null) return;

  const tvlPct = (poolTvl / entry.entryMcap) * 100;
  const { mcapPctThreshold, tightenedTpPct } = config.highTvl;
  const isHighTvl = tvlPct > mcapPctThreshold;

  if (isHighTvl && !entry.highTvlMode) {
    entry.highTvlMode = true;
    entry.takeProfitPct = tightenedTpPct;
    log("manager", `${entry.symbol} (${entry.positionAddress.slice(0, 8)}) — HIGH TVL MODE ON: TP→${tightenedTpPct}% (TVL/MCap=${tvlPct.toFixed(1)}%)`);
    await bot.sendHTML(
      `⚠️ <b>High TVL Mode ON</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(entry.positionAddress.slice(0, 8))}…</code>)\n` +
      `TVL/MCap: <b>${tvlPct.toFixed(1)}%</b> &gt; ${mcapPctThreshold}%\n` +
      `TP tightened to <b>+${tightenedTpPct}%</b>`,
    );
  } else if (!isHighTvl && entry.highTvlMode) {
    entry.highTvlMode = false;
    // Revert to the position's own base TP (custom or default at adoption
    // time), not config's global default — a custom TP must survive a
    // high-TVL guard cycle.
    const baseTp = entry.baseTakeProfitPct ?? config.takeProfitPct;
    entry.takeProfitPct = baseTp;
    log("manager", `${entry.symbol} (${entry.positionAddress.slice(0, 8)}) — HIGH TVL MODE OFF: TP back to ${baseTp}%`);
    await bot.sendHTML(
      `✅ <b>High TVL Mode OFF</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(entry.positionAddress.slice(0, 8))}…</code>)\n` +
      `TVL/MCap back to <b>${tvlPct.toFixed(1)}%</b>\n` +
      `TP back to <b>+${baseTp}%</b>`,
    );
  }
}

// ─── Runner alert (TP bump) ──────────────────────────────────────────────────
// Ported from evilpanda-screener's watcher.js: while a mint's Meteora dynamic
// fee stays above threshold (a sign of real, sustained volume — a "runner"),
// bump TP to 1% so a fast mover isn't cut short by the normal default. Only
// activates once, confirmed by a green 15m candle with >5% move (same bar
// watcher.js uses) — avoids reacting to a single fee spike with no follow-
// through. The confirming candle is still forming (GeckoTerminal's most
// recent bucket for an in-progress interval), so it's re-checked every tick
// while runnerMode is active — not just at activation — and deactivates as
// soon as EITHER the dynamic fee drops back under threshold OR that candle's
// move drops back under +5%, resetting TP to whatever applyHighTvlGuard()
// (runs earlier in the same tick) has currently set as the base — the
// tightened high-TVL value if that guard is still active, otherwise the
// position's own base TP.
// Skipped entirely for positions with a custom TP/SL (entry.customTpSl) —
// only default-TP/SL positions get the automatic bump.
const RUNNER_DYNAMIC_FEE_THRESHOLD = 1; // % — same threshold as watcher.js
const RUNNER_TAKE_PROFIT_PCT = 1;       // % — same bump as watcher.js
// A position that already dipped this deep never gets the runner TP bump,
// even if it later recovers and fee/candle conditions confirm — a position
// that's had to claw back from -5% isn't the "let it run" case the alert is
// meant for. entry.touchedMinus5 is sticky (set once in runExitCheck, never
// cleared) so this guard survives across ticks.
const RUNNER_MINUS5_GUARD_PCT = -5; // %

function clearRunnerMode(entry) {
  entry.runnerMode = false;
  entry.takeProfitPct = entry.highTvlMode
    ? config.highTvl.tightenedTpPct
    : entry.baseTakeProfitPct ?? config.takeProfitPct;
}

async function checkRunnerAlert(entry, poolData) {
  // Only applies to positions still on the default TP/SL — a user who set a
  // custom TP/SL for this position made a deliberate choice that the runner
  // alert shouldn't silently override.
  if (entry.customTpSl) return;
  if (entry.exitMode === "indicator") return; // no TP to bump in this mode

  if (entry.touchedMinus5) {
    if (entry.runnerMode) {
      clearRunnerMode(entry);
      log("manager", `${entry.symbol} (${entry.positionAddress.slice(0, 8)}) — runner alert cancelled (position previously hit ${RUNNER_MINUS5_GUARD_PCT}% PnL), TP back to ${entry.takeProfitPct}%`);
      await bot.sendHTML(
        `✅ <b>Runner Alert cancelled</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(entry.positionAddress.slice(0, 8))}…</code>)\n` +
        `Position previously dipped to ${RUNNER_MINUS5_GUARD_PCT}% PnL · TP back to <b>+${entry.takeProfitPct}%</b>.`,
      );
    }
    return;
  }

  const dynamicFee = Number(poolData?.dynamic_fee_pct);
  if (!Number.isFinite(dynamicFee)) return;

  if (dynamicFee > RUNNER_DYNAMIC_FEE_THRESHOLD) {
    let confirmed = false;
    try {
      const candles = await fetchOhlcv(entry.poolAddress, { aggregate: 15, limit: 2 });
      if (candles.length > 0) {
        const [, open, , , close] = candles[0];
        const o = Number(open), c = Number(close);
        confirmed = o > 0 && c > o && ((c - o) / o) * 100 > 5;
      }
    } catch (e) {
      log("manager_warn", `${entry.symbol}: runner-alert candle check failed: ${e.message}`);
      return; // API hiccup — keep current state, don't flip on a failed check
    }

    if (confirmed) {
      if (entry.runnerMode) return; // already active — TP already bumped, nothing to do
      entry.runnerMode = true;
      entry.takeProfitPct = RUNNER_TAKE_PROFIT_PCT;
      log("manager", `${entry.symbol} (${entry.positionAddress.slice(0, 8)}) — RUNNER ALERT: dynamic fee ${dynamicFee.toFixed(2)}% > ${RUNNER_DYNAMIC_FEE_THRESHOLD}%, TP → ${RUNNER_TAKE_PROFIT_PCT}%`);
      await bot.sendHTML(
        `🏃 <b>Runner Alert</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(entry.positionAddress.slice(0, 8))}…</code>)\n` +
        `Dynamic fee: <b>${dynamicFee.toFixed(2)}%</b> &gt; ${RUNNER_DYNAMIC_FEE_THRESHOLD}% · 15m candle green &gt; +5%\n` +
        `TP bumped to <b>+${RUNNER_TAKE_PROFIT_PCT}%</b> while this holds.`,
      );
    } else if (entry.runnerMode) {
      // Fee is still elevated, but the forming candle's move has dropped
      // back under +5% — the confirmation that justified the bump no
      // longer holds, so cancel it even though the fee condition alone
      // hasn't cleared yet.
      clearRunnerMode(entry);
      log("manager", `${entry.symbol} (${entry.positionAddress.slice(0, 8)}) — runner alert cleared (15m move back under +5%), TP back to ${entry.takeProfitPct}%`);
      await bot.sendHTML(
        `✅ <b>Runner Alert cleared</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(entry.positionAddress.slice(0, 8))}…</code>)\n` +
        `15m candle move back under +5% (dynamic fee still ${dynamicFee.toFixed(2)}%) · TP back to <b>+${entry.takeProfitPct}%</b>.`,
      );
    }
  } else if (entry.runnerMode) {
    clearRunnerMode(entry);
    log("manager", `${entry.symbol} (${entry.positionAddress.slice(0, 8)}) — runner alert cleared, TP back to ${entry.takeProfitPct}%`);
    await bot.sendHTML(
      `✅ <b>Runner Alert cleared</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(entry.positionAddress.slice(0, 8))}…</code>)\n` +
      `Dynamic fee back to <b>${dynamicFee.toFixed(2)}%</b> · TP back to <b>+${entry.takeProfitPct}%</b>.`,
    );
  }
}

// ─── Close (withdraw + swap + journal + notify) ──────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function swapAttempt({ rpcUrl, privateKeyBase58, poolAddress, baseMint, baselineRaw }) {
  try {
    const result = await swapAllToSolFromKey({ rpcUrl, privateKeyBase58, inputMint: baseMint, slippageBps: 100, baselineRaw });
    log("manager", `Jupiter swap done: ${result.sig.slice(0, 20)} — ${(Number(result.outputAmount) / 1e9).toFixed(4)} SOL`);
    return result;
  } catch (jupiterErr) {
    if (jupiterErr.message?.includes("balance to swap")) {
      log("manager_warn", "No token balance after withdraw — assuming all-SOL, no swap.");
      return null;
    }
    log("manager_warn", `Jupiter swap failed (${jupiterErr.message}) — falling back to Meteora`);
    try {
      const result = await swapTokenToSolViaMeteora(rpcUrl, privateKeyBase58, poolAddress, baseMint, baselineRaw);
      log("manager", `Meteora swap done: ${result.sig.slice(0, 20)} — ${(Number(result.outputAmount) / 1e9).toFixed(4)} SOL`);
      return result;
    } catch (meteoraErr) {
      if (meteoraErr.message?.includes("balance to swap")) {
        log("manager", "No token balance after withdraw (Meteora confirmed) — all-SOL, no swap needed");
        return null;
      }
      throw jupiterErr;
    }
  }
}

const SWAP_MAX_ATTEMPTS = 5;
const SWAP_RETRY_DELAY_MS = 3000;

async function swapWithFallback(args) {
  let lastErr;
  for (let attempt = 1; attempt <= SWAP_MAX_ATTEMPTS; attempt++) {
    try {
      return await swapAttempt(args);
    } catch (e) {
      lastErr = e;
      log("manager_warn", `Swap attempt ${attempt}/${SWAP_MAX_ATTEMPTS} failed: ${e.message}`);
      if (attempt < SWAP_MAX_ATTEMPTS) await sleep(SWAP_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

async function executeClose(entry, snap, closeReason, positions) {
  const pk = process.env.SOLANA_PRIVATE_KEY;
  const positionAddress = entry.positionAddress;
  const positionsToClose = snap._positions ?? [];
  if (positionsToClose.length === 0) {
    log("manager_warn", `${entry.symbol}: no positions in datapi for ${positionAddress.slice(0, 8)} — removing stale state`);
    delete positions[positionAddress];
    savePositions(positions);
    return { closed: false };
  }

  log("manager", `Auto-close: ${entry.symbol} (${positionAddress.slice(0, 8)}) — ${closeReason}`);
  await bot.sendHTML(
    `⏳ <b>Auto-Close</b>\n<b>${esc(entry.symbol)}</b> (<code>${esc(positionAddress.slice(0, 8))}…</code>) — ${esc(closeReason)}\nWithdrawing…`,
  );

  // Snapshot the token balance *before* withdrawing. The post-withdraw swap
  // waits for the balance to rise above this — otherwise leftover dust in the
  // ATA (or a lagging RPC read) looks like the withdrawn tokens and only the
  // dust gets sold, stranding the position's real balance in the wallet.
  let baselineRaw = "0";
  try {
    baselineRaw = await getTokenBalanceFromKey({
      rpcUrl: process.env.HELIUS_RPC_URL,
      ownerAddress: process.env.WALLET_ADDRESS,
      mint: entry.baseMint,
    });
    if (baselineRaw !== "0") {
      log("manager", `${entry.symbol}: pre-withdraw ${entry.baseMint.slice(0, 8)} balance ${baselineRaw} (swap will wait past this)`);
    }
  } catch (e) {
    log("manager_warn", `Pre-withdraw balance read failed (${e.message}) — swap falls back to first nonzero balance`);
  }

  const sigs = [];
  let realFailure = false;
  let lastFailMsg = "";
  for (const pos of positionsToClose) {
    try {
      const sig = await withdrawPosition(process.env.HELIUS_RPC_URL, pk, entry.poolAddress, pos);
      sigs.push(sig);
      log("manager", `Withdrew ${pos.publicKey.slice(0, 8)} → ${sig.slice(0, 20)}`);
    } catch (e) {
      if (e.message?.includes("not found on-chain")) {
        log("manager_warn", `Position ${pos.publicKey.slice(0, 8)} already closed on-chain — cleaning up`);
      } else {
        realFailure = true;
        lastFailMsg = e.message ?? "unknown error";
        log("manager_warn", `Withdraw failed for ${pos.publicKey.slice(0, 8)}: ${e.message}`);
      }
    }
  }

  if (sigs.length === 0 && realFailure) {
    entry.closeFailCount = (entry.closeFailCount ?? 0) + 1;
    positions[positionAddress] = entry;
    savePositions(positions);
    if (entry.closeFailCount === 1) {
      await bot.sendHTML(`❌ <b>Withdraw failed</b> for <b>${esc(entry.symbol)}</b>\n${esc(lastFailMsg)}\nWill retry…`);
    }
    if (entry.closeFailCount >= (config.maxCloseFailures ?? 4)) {
      delete positions[positionAddress];
      savePositions(positions);
      log("manager_warn", `${entry.symbol}: withdraw failed ${entry.closeFailCount}× — giving up`);
      await bot.sendHTML(
        `🛑 <b>Auto-close gave up</b> on <b>${esc(entry.symbol)}</b> after ${entry.closeFailCount}× failures.\n` +
        `Position <code>${esc(positionAddress.slice(0, 8))}…</code> removed from management — close manually.`,
      );
    }
    return { closed: false };
  }

  let swapSig = null, solReceived = null, swapFailed = false;
  try {
    const swapResult = await swapWithFallback({
      rpcUrl: process.env.HELIUS_RPC_URL,
      privateKeyBase58: pk,
      poolAddress: entry.poolAddress,
      baseMint: entry.baseMint,
      baselineRaw,
    });
    if (swapResult) {
      swapSig = swapResult.sig;
      solReceived = Number(swapResult.outputAmount) / 1e9;
      await bot.sendHTML(
        `✅ <b>Swap succeeded</b> — <b>${esc(entry.symbol)}</b> → SOL\n` +
        `Received: <b>${solReceived.toFixed(4)} SOL</b>\n` +
        `<code>${esc(swapSig.slice(0, 20))}…</code>`,
      );
    } else {
      await bot.sendHTML(
        `✅ <b>Swap skipped</b> — <b>${esc(entry.symbol)}</b> already all-SOL, nothing to swap.`,
      );
    }
  } catch (e) {
    swapFailed = true;
    log("manager_warn", `Swap failed for ${entry.symbol}: ${e.message}`);
    await bot.sendHTML(
      `⚠️ <b>Swap failed</b> — tokens withdrawn but not swapped to SOL\n${esc(e.message)}\nSwap manually via Jupiter: <code>${esc(entry.baseMint)}</code>`,
    );
  }

  appendJournal({
    symbol: entry.symbol,
    mint: entry.baseMint,
    poolAddress: entry.poolAddress,
    positionAddress,
    adoptedAt: entry.adoptedAt,
    closedAt: Math.floor(Date.now() / 1000),
    closeReason,
    closeTxSig: sigs[0] ?? null,
    swapTxSig: swapSig,
    pnlPct: snap.pnlPct,
    pnlUsd: snap.pnlUsd,
    pnlSol: snap.pnlSol,
    feesUsd: snap.feesUsd,
    solReceived,
    oor: snap.oor,
  });

  delete positions[positionAddress];
  savePositions(positions);
  slBelowCount.delete(positionAddress);

  const poolLink = `https://app.meteora.ag/dlmm/${entry.poolAddress}`;
  const closeCaption =
    `${swapFailed ? "⚠️" : "✅"} <b>Closed</b>${swapFailed ? " — swap gagal" : ""}\n` +
    `<b>${esc(entry.symbol)}</b> (<code>${esc(positionAddress.slice(0, 8))}…</code>) — ${esc(closeReason)}\n` +
    `<i>PnL: ${fmtPct(snap.pnlPct)} · ${fmtUsd(snap.pnlUsd)}</i>\n` +
    `Fees: ${fmtUsd(snap.feesUsd)}\n` +
    (solReceived != null ? `SOL received: <b>${solReceived.toFixed(4)} SOL</b>\n` : "") +
    `<a href="${poolLink}">Pool</a>${sigs[0] ? ` · Withdraw: <code>${sigs[0].slice(0, 20)}…</code>` : ""}`;

  try {
    const png = await renderPnlCard({
      win: (snap.pnlPct ?? 0) >= 0,
      symbol: entry.symbol,
      detail: closeReason,
      pnlUsd: snap.pnlUsd,
      pnlSol: snap.pnlSol,
      pnlPct: snap.pnlPct,
    });
    await bot.sendPhoto(png, closeCaption);
  } catch (e) {
    log("manager_warn", `PnL card render failed: ${e.message} — falling back to text`);
    await bot.sendHTML(closeCaption);
  }

  log("manager", `Closed: ${entry.symbol} (${positionAddress.slice(0, 8)}) ${closeReason}`);
  return { closed: true };
}

// ─── Core tick — SL/TP/OOR check on every managed position ───────────────────

export async function runExitCheck() {
  const wallet = process.env.WALLET_ADDRESS;
  if (!process.env.HELIUS_RPC_URL || !wallet) {
    log("manager_warn", "HELIUS_RPC_URL or WALLET_ADDRESS not set — skipping");
    return { positions: 0, closed: 0 };
  }

  const positions = loadPositions();
  const entries = Object.values(positions);
  if (entries.length === 0) return { positions: 0, closed: 0 };

  let closedCount = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const entry of entries) {
    if (nowSec - entry.adoptedAt < config.gracePeriodSec) continue; // grace period

    let snap;
    try {
      snap = await buildSnapshot(entry, wallet);
    } catch (e) {
      log("manager_warn", `snapshot failed for ${entry.positionAddress.slice(0, 8)}: ${e.message}`);
      continue;
    }

    if (!snap.matched) {
      const n = (missingCount.get(entry.positionAddress) ?? 0) + 1;
      missingCount.set(entry.positionAddress, n);
      log("manager_warn", `${entry.positionAddress.slice(0, 8)} (${entry.symbol}): not in datapi's open positions (${n}/${MISSING_CONSECUTIVE_TICKS})`);

      if (n >= MISSING_CONSECUTIVE_TICKS) {
        let stillExists = true;
        try {
          stillExists = await positionAccountExists(process.env.HELIUS_RPC_URL, entry.positionAddress);
        } catch (e) {
          log("manager_warn", `on-chain existence check failed for ${entry.positionAddress.slice(0, 8)}: ${e.message}`);
        }

        if (!stillExists) {
          delete positions[entry.positionAddress];
          savePositions(positions);
          slBelowCount.delete(entry.positionAddress);
          missingCount.delete(entry.positionAddress);
          log("manager", `${entry.positionAddress.slice(0, 8)} (${entry.symbol}) — position no longer exists on-chain, auto-forgot`);
          await bot.sendRichHTML(
            card({
              emoji: "🗑️",
              title: "Position Gone",
              subtitle: `<b>${esc(entry.symbol)}</b>`,
              rows: [
                ["Position", `<code>${esc(entry.positionAddress.slice(0, 8))}…</code>`],
                ["Note", "Closed outside the bot (manual close?) — stopped managing it."],
              ],
            }),
          );
          continue;
        }
      }
      continue; // no PnL data this tick — skip SL/TP/OOR evaluation
    }
    missingCount.delete(entry.positionAddress);

    let poolData = null;
    try {
      poolData = await fetchPoolInfo(entry.poolAddress);
    } catch (e) {
      log("manager_warn", `pool info fetch failed for ${entry.positionAddress.slice(0, 8)}: ${e.message}`);
    }

    if (snap.pnlPct != null && snap.pnlPct <= RUNNER_MINUS5_GUARD_PCT) {
      entry.touchedMinus5 = true;
    }

    try {
      await applyHighTvlGuard(entry, poolData);
      await checkRunnerAlert(entry, poolData);
      positions[entry.positionAddress] = entry;
    } catch (e) {
      log("manager_warn", `guard checks failed for ${entry.positionAddress.slice(0, 8)}: ${e.message}`);
    }

    log("manager", `${entry.positionAddress.slice(0, 8)} (${entry.symbol}) — OOR=${snap.oor} pnl=${snap.pnlPct?.toFixed(1) ?? "—"}%`);

    let closeReason = null;

    // Indicator Exit positions replace the PnL take-profit with the 15m
    // RSI/MACD/Bollinger signal. SL is opt-in per position for indicator mode
    // (chosen at adoption time via entry.slEnabled/stopLossPct) — always on
    // for pnl mode. OOR close is still governed by config.indicatorExit.
    const indicatorMode = entry.exitMode === "indicator";
    const slEnabled = indicatorMode ? entry.slEnabled === true : true;
    const oorEnabled = config.oorCloseEnabled
      && (!indicatorMode || (config.indicatorExit?.keepOorClose ?? true));

    // SL evaluation mode — "pnl" (legacy default), "oorBelow" (fires on
    // downside OOR regardless of PnL%), or "both" (whichever hits first).
    // Independent of oorCloseEnabled below, which still closes on OOR in
    // either direction regardless of slMode. entry.stopLossPct is null when
    // an indicator-mode position declined SL — pnlSlHit stays false then.
    const slMode = entry.slMode ?? config.slMode ?? "pnl";
    const oorGraceSec = entry.oorCloseDurationSec ?? config.oorCloseDurationSec ?? 0;
    const pnlSlHit = entry.stopLossPct != null && snap.pnlPct != null && snap.pnlPct <= entry.stopLossPct;
    // With a grace duration set, OOR-below is closed by the grace timer below
    // instead — firing it here too would close after 2 ticks and skip the grace.
    const oorBelowSlHit = snap.oorBelow === true && oorGraceSec <= 0;
    const slHit = slEnabled && (
      slMode === "oorBelow" ? oorBelowSlHit :
      slMode === "both" ? (pnlSlHit || oorBelowSlHit) :
      pnlSlHit);

    if (slHit) {
      const n = (slBelowCount.get(entry.positionAddress) ?? 0) + 1;
      slBelowCount.set(entry.positionAddress, n);
      if (n >= (config.slConsecutiveTicks ?? 2)) {
        const reasonBits = [];
        if (pnlSlHit) reasonBits.push(`PnL ${fmtPct(snap.pnlPct)} ≤ ${entry.stopLossPct}%`);
        if (oorBelowSlHit) reasonBits.push("OOR below range");
        closeReason = `SL — ${reasonBits.join(" & ")}`;
      }
    } else {
      slBelowCount.delete(entry.positionAddress);
    }

    // OOR-below never force-closes a position on its own — only slMode
    // "oorBelow"/"both" treat it as a close trigger (handled above via
    // oorBelowSlHit). Every other mode (including plain "pnl" SL and
    // Indicator Exit) just gets a one-time alert on the downside break, since
    // OOR-below alone isn't a signal those modes were configured to act on.
    // OOR-above is unaffected and always closes via the generic check below.
    const oorBelowHandledBySl = slEnabled && (slMode === "oorBelow" || slMode === "both");
    if (!closeReason && snap.oorBelow && !oorBelowHandledBySl) {
      if (!entry.oorBelowAlerted) {
        entry.oorBelowAlerted = true;
        positions[entry.positionAddress] = entry;
        log("manager", `${entry.positionAddress.slice(0, 8)} (${entry.symbol}) — price broke below range (slMode: ${slMode}) — alerting only, not closing`);
        await bot.sendHTML(
          `⚠️ <b>Price Below Range</b> — <b>${esc(entry.symbol)}</b> (<code>${esc(entry.positionAddress.slice(0, 8))}…</code>)\n` +
          `Active price dropped below the position's lower bin. SL mode is <b>${esc(slMode)}</b>, which doesn't treat OOR-below as a close trigger, so it will <b>not</b> auto-close — review manually.\n` +
          `PnL: ${fmtPct(snap.pnlPct)} · ${fmtUsd(snap.pnlUsd)}`,
        );
      }
    } else if (!snap.oorBelow && entry.oorBelowAlerted) {
      entry.oorBelowAlerted = false;
      positions[entry.positionAddress] = entry;
    }

    if (!closeReason && indicatorMode) {
      const verdict = await evaluateIndicatorExit(entry.poolAddress);
      if (verdict.error) {
        log("manager_warn", `${entry.positionAddress.slice(0, 8)} (${entry.symbol}): indicator exit check skipped — ${verdict.error}`);
      } else {
        log("manager", `${entry.positionAddress.slice(0, 8)} (${entry.symbol}) — ${summarizeIndicators(verdict.detail)}`);
        if (verdict.triggered) closeReason = verdict.reason;
      }
    } else if (!closeReason) {
      const tpThreshold = entry.takeProfitPct * (1 - (config.tpTolerancePct ?? 0));
      if (snap.pnlPct != null && snap.pnlPct >= tpThreshold) {
        closeReason = `TP ${fmtPct(snap.pnlPct)} ≥ +${tpThreshold.toFixed(2)}% (target +${entry.takeProfitPct}%, -${((config.tpTolerancePct ?? 0) * 100).toFixed(0)}% tolerance)`;
      }
    }

    // OOR *above* always closes instantly (favorable break, no reason to
    // hold off) — never subject to the grace duration below.
    if (!closeReason && snap.oorAbove && oorEnabled) {
      closeReason = "OOR (out of range) — favorable break";
    }

    // OOR *below* only lands here — as a close trigger — when slMode
    // explicitly treats it as one (oorBelowHandledBySl above); otherwise
    // it was already handled by the alert-only path. Can optionally wait
    // entry.oorCloseDurationSec before actually closing (user-chosen at
    // adoption time), instead of closing the instant the range breaks.
    if (!closeReason && snap.oorBelow && oorBelowHandledBySl && oorEnabled && oorGraceSec > 0) {
      if (!entry.oorSince) entry.oorSince = nowSec;
      const elapsed = nowSec - entry.oorSince;
      if (elapsed >= oorGraceSec) {
        closeReason = `OOR below range for ${elapsed}s ≥ ${oorGraceSec}s grace`;
      }
    } else if (entry.oorSince) {
      entry.oorSince = null;
    }

    if (closeReason) {
      const result = await executeClose(entry, snap, closeReason, positions);
      if (result.closed) closedCount++;
    } else {
      savePositions(positions);
    }
  }

  return { positions: entries.length, closed: closedCount };
}

export async function statusText() {
  const positions = Object.values(loadPositions());
  if (positions.length === 0) return "No managed positions. Send /scan to adopt on-chain positions.";
  const wallet = process.env.WALLET_ADDRESS;
  const nowSec = Math.floor(Date.now() / 1000);
  const blocks = [`<p><b>Managed positions (${positions.length})</b></p>`];
  for (const entry of positions) {
    const deposit = entry.depositSol != null
      ? `${entry.depositSol.toFixed(4)} SOL${entry.depositUsd != null ? ` ($${entry.depositUsd.toFixed(2)})` : ""}`
      : "—";

    let pnlDetail = "—";
    if (wallet) {
      try {
        const snap = await buildSnapshot(entry, wallet);
        pnlDetail = `<b>${fmtPct(snap.pnlPct)}</b> · ${fmtUsd(snap.pnlUsd)}${snap.oor ? " · OOR" : ""}`;
      } catch (e) {
        log("manager_warn", `status snapshot failed for ${entry.positionAddress.slice(0, 8)}: ${e.message}`);
      }
    }

    const indicatorMode = entry.exitMode === "indicator";
    const slPart = indicatorMode
      ? (entry.slEnabled === true && entry.stopLossPct != null ? `${entry.stopLossPct}%` : "off")
      : `${entry.stopLossPct}%`;
    const tpSlDetail = indicatorMode
      ? `📈 Indicator Exit (RSI${config.indicatorExit?.rsiPeriod ?? 2}&gt;${config.indicatorExit?.rsiThreshold ?? 90} + MACD/BB, ${config.indicatorExit?.timeframeMinutes ?? 15}m) / SL ${slPart}` +
        `${entry.slMode && entry.slMode !== "pnl" ? ` (mode: ${entry.slMode})` : ""}` +
        `${entry.oorBelowAlerted ? " (⚠️ below range — not closing, no SL)" : ""}`
      : `+${entry.takeProfitPct}% / ${entry.stopLossPct}%` +
        `${entry.slMode && entry.slMode !== "pnl" ? ` (mode: ${entry.slMode})` : ""}` +
        `${entry.customTpSl ? " (custom)" : ""}` +
        `${entry.highTvlMode ? " (high-TVL)" : ""}` +
        `${entry.runnerMode ? " (🏃 runner)" : ""}`;

    const rows = [
      row("Position", `<code>${esc(entry.positionAddress.slice(0, 8))}…</code>`),
      row("Bins", `${entry.lowerBinId}–${entry.upperBinId} (${entry.binCount})`),
      row("Shape", esc(entry.shape ?? "—")),
      row("Deposit", esc(deposit)),
      row("PnL", pnlDetail),
      row("TP / SL", tpSlDetail),
    ];
    if (entry.slMode === "oorBelow" || entry.slMode === "both") {
      const graceSec = entry.oorCloseDurationSec ?? 0;
      const graceLabel = graceSec > 0 ? `${graceSec}s` : "instant";
      rows.push(row("OOR grace", esc(graceLabel) + (entry.oorSince ? ` (breaking — ${nowSec - entry.oorSince}s elapsed)` : "")));
    }

    blocks.push(card({
      emoji: "📟",
      title: "Managed Position",
      subtitle: `<b>${esc(entry.symbol)}</b> · pool <code>${esc(entry.poolAddress.slice(0, 8))}…</code>`,
      rows,
      links: [`<a href="https://app.meteora.ag/dlmm/${entry.poolAddress}">Pool</a>`],
    }));
  }
  return blocks.join("\n\n");
}
