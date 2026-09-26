/**
 * Meteora DLMM client.
 *
 * Two surfaces:
 * 1. REST pool lookup — `https://dlmm.datapi.meteora.ag` (30 RPS)
 *    Used by the screener to find Meteora pools for a trending token.
 * 2. On-chain position enumeration via @meteora-ag/dlmm SDK + Solana RPC.
 *    Used by the manager to list the wallet's open DLMM LP positions.
 *
 * SDK is loaded via `createRequire` because its CJS deps reference directories
 * without index files, which ESM's dir-import rejects.
 */

import { createRequire } from "module";
import { config } from "../config.js";
import { getTokenBalance } from "./jupiter.js";

const HOST = process.env.METEORA_DLMM_HOST ?? "https://dlmm.datapi.meteora.ag";

const require = createRequire(import.meta.url);
const bs58 = require("bs58");
const BN   = require("bn.js");

export const QUOTE_MINTS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const GECKO_HOST = "https://api.geckoterminal.com/api/v2";

// Solana RPC calls (getAccountInfo, sendAndConfirmTransaction, etc.) have no
// built-in timeout — if the RPC node stops responding mid-request, the promise
// just hangs forever instead of rejecting. That once froze the whole bot: a
// hung withdraw call kept index.js's tickRunning flag stuck `true` and every
// cron tick after it was skipped indefinitely. Wrap RPC-bound calls with this
// so they reject on a stall instead of hanging.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Helius's getPriorityFeeEstimate (same RPC endpoint, custom method) — returns
// microLamports/CU. Falls back to `floor` if the RPC doesn't support the
// method (non-Helius endpoint) or the call fails/times out, so this never
// blocks a withdraw on the fee lookup itself.
async function getPriorityFeeMicroLamports(rpcUrl, accountKeys, { floorMicroLamports, capMicroLamports }) {
  try {
    const res = await withTimeout(
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "withdraw-priority-fee",
          method: "getPriorityFeeEstimate",
          params: [{ accountKeys, options: { recommended: true } }],
        }),
      }).then((r) => r.json()),
      5_000,
      "getPriorityFeeEstimate",
    );
    const estimate = res?.result?.priorityFeeEstimate;
    if (typeof estimate === "number" && estimate > 0) {
      return Math.min(capMicroLamports, Math.max(floorMicroLamports, Math.round(estimate)));
    }
  } catch {
    // Non-Helius RPC or a transient failure — fall back to the floor below.
  }
  return floorMicroLamports;
}

// Find Meteora DLMM pool addresses for a token via GeckoTerminal, then hydrate
// each address with full metadata from the Meteora datapi.
async function fetchMeteoraPools(mint) {
  const res = await fetch(`${GECKO_HOST}/networks/solana/tokens/${mint}/pools?limit=20`);
  if (!res.ok) throw new Error(`GeckoTerminal pools ${res.status}`);
  const body = await res.json();
  const meteoraAddrs = (body.data ?? [])
    .filter((p) => p.relationships?.dex?.data?.id === "meteora")
    .map((p) => p.attributes?.address)
    .filter(Boolean);

  const results = await Promise.allSettled(
    meteoraAddrs.map((addr) => fetch(`${HOST}/pools/${addr}`).then((r) => r.ok ? r.json() : null)),
  );
  return results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}

/**
 * Fetch PnL data for all open positions in a pool via Meteora datapi.
 *
 * Returns the full response body:
 *   { positions: [{ positionAddress, pnlUsd, pnlSol, pnlPctChange,
 *                   isOutOfRange, poolActiveBinId, lowerBinId, upperBinId,
 *                   allTimeDeposits, allTimeFees, unrealizedPnl, ... }] }
 */
export async function fetchDlmmPnl(poolAddress, walletAddress) {
  const url = `${HOST}/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora datapi PnL ${res.status} for pool ${poolAddress.slice(0, 8)}`);
  return res.json();
}

/**
 * Fetch a single DLMM pool's metadata (name, token symbols, price, mcap).
 * Returns null on 404 so callers can degrade to the mint-only display.
 */
export async function fetchPoolInfo(poolAddress) {
  const url = `${HOST}/pools/${poolAddress}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Meteora /pools/${poolAddress} ${res.status} ${res.statusText}`);
  return await res.json();
}

/**
 * Return all DLMM pools where one side is `mint` and the other is a known quote.
 * Each pool has: address, pool_config.{bin_step, base_fee_pct}, token_x, token_y, tvl.
 */
export async function fetchPoolsForToken(mint) {
  const pools = await fetchMeteoraPools(mint);
  const quoteSet = new Set(Object.values(QUOTE_MINTS));
  return pools.filter((p) =>
    quoteSet.has(p.token_x?.address) || quoteSet.has(p.token_y?.address),
  );
}

/**
 * Check whether a DLMM position account still exists on-chain. A position
 * account is closed (rent reclaimed) once its liquidity is fully withdrawn —
 * whether that withdrawal was done by this bot or manually — so a null
 * result here means the position is gone for good, not just temporarily
 * out of range.
 *
 * @param {string} rpcUrl
 * @param {string} positionAddress
 * @returns {Promise<boolean>}
 */
export async function positionAccountExists(rpcUrl, positionAddress) {
  const { Connection, PublicKey } = require("@solana/web3.js");
  const conn = new Connection(rpcUrl, "confirmed");
  const info = await conn.getAccountInfo(new PublicKey(positionAddress));
  return info !== null;
}

/**
 * Enumerate all open DLMM LP positions for a wallet via Solana RPC.
 *
 * Uses the Meteora SDK's `DLMM.getAllLbPairPositionsByUser`, which does a single
 * getProgramAccounts call filtered by owner, so it's cheap (~0.5–1s per invocation).
 *
 * @param {string} rpcUrl    — full RPC URL (Helius preferred for getProgramAccounts)
 * @param {string} walletAddress — base58 Solana pubkey
 * @returns {Promise<Array<{
 *   poolAddress: string,
 *   baseMint: string,
 *   quoteMint: string,
 *   positions: Array<{ publicKey: string, lowerBinId: number, upperBinId: number, totalXAmount: string, totalYAmount: string }>
 * }>>}
 */
export async function fetchUserPositions(rpcUrl, walletAddress) {
  const DLMM = require("@meteora-ag/dlmm");
  const { Connection, PublicKey } = require("@solana/web3.js");

  const conn = new Connection(rpcUrl, "confirmed");
  const wallet = new PublicKey(walletAddress);
  const byPool = await DLMM.getAllLbPairPositionsByUser(conn, wallet);

  const bnStr = (v) => (v == null ? "0" : typeof v === "string" ? v : v.toString?.() ?? "0");

  const out = [];
  for (const [poolAddress, entry] of byPool) {
    const positions = (entry.lbPairPositionsData ?? []).map((p) => ({
      publicKey: p.publicKey.toBase58(),
      lowerBinId: p.positionData.lowerBinId,
      upperBinId: p.positionData.upperBinId,
      totalXAmount: bnStr(p.positionData.totalXAmount),
      totalYAmount: bnStr(p.positionData.totalYAmount),
      feeX: bnStr(p.positionData.feeX),
      feeY: bnStr(p.positionData.feeY),
      totalClaimedFeeX: bnStr(p.positionData.totalClaimedFeeXAmount),
      totalClaimedFeeY: bnStr(p.positionData.totalClaimedFeeYAmount),
      // Per-bin liquidity — used to infer the deposit shape (Spot/Curve/Bid-Ask)
      // without an extra RPC call, since the SDK already fetched it.
      positionBinData: (p.positionData.positionBinData ?? []).map((b) => ({
        binId: b.binId,
        positionLiquidity: bnStr(b.positionLiquidity),
      })),
    }));
    if (positions.length === 0) continue;

    // Fetch active bin price from SDK — tokenX price in tokenY (SOL if SOL-quoted).
    // pricePerToken is already decimal-adjusted (human units).
    let currentPriceXInY = null;
    let activeBinId = null;
    try {
      const activeBin = await entry.lbPair.getActiveBin();
      currentPriceXInY = activeBin?.pricePerToken != null ? Number(activeBin.pricePerToken) : null;
      activeBinId      = activeBin?.binId         != null ? Number(activeBin.binId)          : null;
    } catch { /* non-fatal — PnL and OOR fall back to null */ }

    out.push({
      poolAddress,
      baseMint: entry.lbPair.tokenXMint.toBase58(),
      quoteMint: entry.lbPair.tokenYMint.toBase58(),
      baseDecimals: entry.tokenX?.mint?.decimals ?? entry.tokenX?.decimals ?? 6,
      quoteDecimals: entry.tokenY?.mint?.decimals ?? entry.tokenY?.decimals ?? 9,
      currentPriceXInY,
      activeBinId,
      positions,
    });
  }
  return out;
}

/**
 * Withdraw 100% of liquidity from a single position and close it.
 *
 * @param {string} rpcUrl
 * @param {string} privateKeyBase58  — wallet private key as base58 string
 * @param {string} poolAddress       — DLMM pool pubkey
 * @param {{ publicKey: string, lowerBinId: number, upperBinId: number }} position
 * @returns {Promise<string>}        — transaction signature
 */
export async function withdrawPosition(rpcUrl, privateKeyBase58, poolAddress, position) {
  const DLMM = require("@meteora-ag/dlmm");
  const { Connection, PublicKey, Keypair, ComputeBudgetProgram, sendAndConfirmTransaction } = require("@solana/web3.js");

  const secretKey = bs58.default?.decode
    ? bs58.default.decode(privateKeyBase58)
    : bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  const conn    = new Connection(rpcUrl, "confirmed");

  const positionPubkey = new PublicKey(position.publicKey);
  const poolPubkey     = new PublicKey(poolAddress);

  // Guard: if the position account is gone (already closed or stale datapi),
  // fail fast with a clear message instead of paying for DLMM.create()'s
  // multi-round-trip pool/bin-array fetch only to null-deref inside the SDK.
  // A single getAccountInfo call here is far cheaper than DLMM.create(), so
  // check existence before doing any of that heavier work.
  const positionAccount = await withTimeout(
    conn.getAccountInfo(positionPubkey),
    15_000,
    "getAccountInfo",
  );
  if (!positionAccount) {
    throw new Error(`Position ${position.publicKey.slice(0, 8)} not found on-chain — already closed or datapi stale`);
  }

  const lbPair = await withTimeout(DLMM.create(conn, poolPubkey), 20_000, "DLMM.create");

  // Remove 100% (10000 bps), claim all fees, and close the position account.
  // Retry up to 3× — each attempt gets a fresh transaction (new blockhash) from
  // the SDK, so TransactionExpiredBlockheightExceededError is safe to retry.
  // On-chain execution failures (custom program errors) are not retried.

  // The datapi's lowerBinId/upperBinId can be missing/null for positions it
  // indexes poorly (e.g. orphans from a failed open, or fresh positions it
  // hasn't caught up on yet) — falling back to `undefined` here crashes the
  // SDK deep inside removeLiquidity ("Cannot read properties of undefined
  // (reading 'binId')") and the position is then abandoned on-chain with its
  // liquidity never withdrawn. Re-derive the range from the on-chain account
  // itself, which is always authoritative, whenever the caller-supplied range
  // looks incomplete.
  let lowerBinId = position.lowerBinId;
  let upperBinId = position.upperBinId;
  if (lowerBinId == null || upperBinId == null) {
    const onChainPos = await withTimeout(lbPair.getPosition(positionPubkey), 20_000, "getPosition");
    lowerBinId = onChainPos.positionData.lowerBinId;
    upperBinId = onChainPos.positionData.upperBinId;
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const txs = await withTimeout(
        lbPair.removeLiquidity({
          user:              keypair.publicKey,
          position:          positionPubkey,
          fromBinId:         lowerBinId,
          toBinId:           upperBinId,
          bps:               new BN(10000),
          shouldClaimAndClose: true,
        }),
        20_000,
        "removeLiquidity",
      );

      // removeLiquidity may return a single Transaction or an array.
      const txList = Array.isArray(txs) ? txs : [txs];

      // The SDK builds this tx with no priority fee at all, which is what let
      // it sit unconfirmed until blockhash expiry under congestion. Prepend a
      // dynamic priority fee (Helius estimate, clamped) to each tx so it's
      // actually competitive for block inclusion.
      const priorityFee = await getPriorityFeeMicroLamports(
        rpcUrl,
        [poolPubkey.toBase58(), positionPubkey.toBase58()],
        config.withdrawPriorityFee,
      );
      const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });
      for (const tx of txList) {
        tx.instructions.unshift(priorityIx);
      }

      let lastSig = null;
      for (const tx of txList) {
        lastSig = await withTimeout(
          sendAndConfirmTransaction(conn, tx, [keypair], {
            commitment:    "confirmed",
            skipPreflight: true,
          }),
          45_000,
          "sendAndConfirmTransaction",
        );
      }
      return lastSig;
    } catch (e) {
      lastErr = e;
      const msg = e.message ?? "";
      // SDK's wrapPosition reads account.data without a null guard; if the position
      // was closed between our pre-check and the SDK's internal fetch, re-throw with
      // the same sentinel so manager.js can clean up state silently.
      if (msg.includes("Cannot read properties of null") || (e instanceof TypeError && msg.includes("'data'"))) {
        throw new Error(`Position ${position.publicKey.slice(0, 8)} not found on-chain — already closed or datapi stale`);
      }
      // Custom program errors (e.g., invalid account state) won't succeed on retry.
      if (msg.includes("custom program error") || msg.includes("Error processing Instruction")) {
        break;
      }
      // With a priority fee now in play, most withdraws land on the first
      // attempt — this backoff only exists as a brief cooldown before retrying
      // after a transient failure, not to wait out congestion.
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

/**
 * Rebalance a managed position to the pool's current price — quote-side
 * (SOL) only. Withdraws 100% of the existing position's liquidity + fees,
 * then redeposits *only the quote side* into a range that sits strictly
 * below the current active bin (never including it), sized to `rangeBins`
 * and shaped by `strategy`. Any base-token amount claimed on withdraw (fees
 * or leftover) is never redeposited — it's simply left in the wallet, since
 * a range that starts below the active bin can never require the base
 * token side. Built on the DLMM SDK's native rebalance instruction
 * (`simulateRebalancePosition` + `rebalancePosition`) — one on-chain
 * instruction, same position address, no new position account created.
 *
 * @param {string} rpcUrl
 * @param {string} privateKeyBase58
 * @param {string} poolAddress
 * @param {{ publicKey: string }} position
 * @param {{ strategy: "Spot"|"Curve"|"BidAsk", rangeBins: number, depositLamports?: string|null, maxActiveBinSlippage?: number }} opts
 *   depositLamports null/undefined = redeposit everything withdrawn (quote side + quote fees).
 * @returns {Promise<{ sigs: string[], lowerBinId: number, upperBinId: number, depositedLamports: string }>}
 */
export async function rebalancePositionOneSidedQuote(rpcUrl, privateKeyBase58, poolAddress, position, opts = {}) {
  const DLMM = require("@meteora-ag/dlmm");
  const { Connection, PublicKey, Keypair, ComputeBudgetProgram, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");

  const strategy = opts.strategy ?? "Spot";
  const rangeBins = Number(opts.rangeBins);
  const maxActiveBinSlippage = opts.maxActiveBinSlippage ?? 3;
  if (!Number.isInteger(rangeBins) || rangeBins <= 0) {
    throw new Error("rangeBins must be a positive integer");
  }

  const secretKey = bs58.default?.decode
    ? bs58.default.decode(privateKeyBase58)
    : bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  const conn    = new Connection(rpcUrl, "confirmed");

  const positionPubkey = new PublicKey(position.publicKey);
  const poolPubkey     = new PublicKey(poolAddress);

  const positionAccount = await withTimeout(conn.getAccountInfo(positionPubkey), 15_000, "getAccountInfo");
  if (!positionAccount) {
    throw new Error(`Position ${position.publicKey.slice(0, 8)} not found on-chain — already closed or datapi stale`);
  }

  const lbPair = await withTimeout(DLMM.create(conn, poolPubkey), 20_000, "DLMM.create");
  const onChainPos = await withTimeout(lbPair.getPosition(positionPubkey), 20_000, "getPosition");
  const { positionData } = onChainPos;

  const activeBin = await withTimeout(lbPair.getActiveBin(), 15_000, "getActiveBin");
  const activeId = new BN(activeBin.binId);
  const binStep = new BN(lbPair.lbPair.binStep);
  const strategyType = DLMM.StrategyType?.[strategy] ?? DLMM.StrategyType.Spot;

  // Withdraw the entire existing range.
  const withdrawParam = {
    minBinId: new BN(positionData.lowerBinId),
    maxBinId: new BN(positionData.upperBinId),
    bps: new BN(10000),
  };

  // Quote side only — X (base) amount is always 0. Range is strictly below
  // the active bin (maxDeltaId = -1), so the active bin itself, which needs
  // both sides, is never part of the new range. This is what forces the
  // rebalance to be single-sided on the quote token, always.
  const totalWithdrawnY = new BN(positionData.totalYAmount).add(new BN(positionData.feeY));
  const depositAmountY = opts.depositLamports != null ? new BN(opts.depositLamports) : totalWithdrawnY;
  if (depositAmountY.lten(0)) {
    throw new Error("Deposit amount must be greater than zero.");
  }

  const minDeltaId = new BN(-rangeBins);
  const maxDeltaId = new BN(-1);

  const strategyParams = DLMM.buildLiquidityStrategyParameters(
    new BN(0), depositAmountY, minDeltaId, maxDeltaId, binStep, false, activeId,
    DLMM.getLiquidityStrategyParameterBuilder(strategyType),
  );

  const depositParam = {
    minDeltaId, maxDeltaId,
    x0: strategyParams.x0, y0: strategyParams.y0,
    deltaX: strategyParams.deltaX, deltaY: strategyParams.deltaY,
    favorXInActiveBin: false,
  };

  const rebalanceResponse = await withTimeout(
    lbPair.simulateRebalancePosition(positionPubkey, positionData, true, true, [depositParam], [withdrawParam]),
    20_000,
    "simulateRebalancePosition",
  );

  const { initBinArrayInstructions, rebalancePositionInstruction } = await withTimeout(
    lbPair.rebalancePosition(rebalanceResponse, new BN(maxActiveBinSlippage), keypair.publicKey, 100),
    20_000,
    "rebalancePosition",
  );

  const priorityFee = await getPriorityFeeMicroLamports(
    rpcUrl,
    [poolPubkey.toBase58(), positionPubkey.toBase58()],
    config.withdrawPriorityFee,
  );
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });

  const sigs = [];
  // New bin arrays the below-active range needs (if not already
  // initialized) must land on-chain before the rebalance instruction
  // itself, so they're sent as their own transaction first.
  if (initBinArrayInstructions.length > 0) {
    const tx = new Transaction().add(priorityIx, ...initBinArrayInstructions);
    const sig = await withTimeout(
      sendAndConfirmTransaction(conn, tx, [keypair], { commitment: "confirmed", skipPreflight: true }),
      45_000,
      "sendAndConfirmTransaction(initBinArrays)",
    );
    sigs.push(sig);
  }

  const rebalanceTx = new Transaction().add(priorityIx, ...rebalancePositionInstruction);
  const rebalanceSig = await withTimeout(
    sendAndConfirmTransaction(conn, rebalanceTx, [keypair], { commitment: "confirmed", skipPreflight: true }),
    45_000,
    "sendAndConfirmTransaction(rebalance)",
  );
  sigs.push(rebalanceSig);

  return {
    sigs,
    lowerBinId: activeId.toNumber() + minDeltaId.toNumber(),
    upperBinId: activeId.toNumber() + maxDeltaId.toNumber(),
    depositedLamports: depositAmountY.toString(),
  };
}

/**
 * Swap a token back to SOL using the Meteora DLMM pool it came from.
 *
 * Queries the wallet's token balance (with retry to handle RPC lag after a
 * withdraw), gets a swap quote, and executes the swap in the same pool.
 *
 * Returns { sig, inputAmount, outputAmount } — outputAmount is in lamports.
 */
export async function swapTokenToSolViaMeteora(rpcUrl, privateKeyBase58, poolAddress, inputMint, baselineRaw = "0") {
  const DLMM = require("@meteora-ag/dlmm");
  const { Connection, PublicKey, Keypair, sendAndConfirmTransaction } = require("@solana/web3.js");

  const secretKey = bs58.default?.decode
    ? bs58.default.decode(privateKeyBase58)
    : bs58.decode(privateKeyBase58);
  const keypair    = Keypair.fromSecretKey(secretKey);
  const conn       = new Connection(rpcUrl, "confirmed");
  const inputPubkey = new PublicKey(inputMint);

  // Retry balance check — RPC may lag behind a freshly confirmed withdraw tx.
  // The balance must exceed `baselineRaw` (what the wallet held *before* the
  // withdraw), or leftover dust read from a lagging RPC ends the poll early and
  // only the dust gets swapped — see waitForWithdrawnBalance in api/jupiter.js.
  const baseline = BigInt(baselineRaw || "0");
  let rawAmount = "0";
  for (let attempt = 1; attempt <= 5; attempt++) {
    rawAmount = await getTokenBalance(conn, keypair.publicKey, inputMint);
    if (BigInt(rawAmount) > baseline) break;
    if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!rawAmount || rawAmount === "0") {
    throw new Error(`No ${inputMint.slice(0, 8)}… balance to swap`);
  }

  const pool     = await DLMM.create(conn, new PublicKey(poolAddress));
  const swapForY = inputPubkey.equals(pool.tokenX.mint); // X→SOL(Y) or Y→SOL(X)
  const outToken = swapForY ? pool.tokenY.mint : pool.tokenX.mint;
  const inAmount = new BN(rawAmount);

  const binArrays = await pool.getBinArrayForSwap(swapForY, 4);
  if (!binArrays || binArrays.length === 0) {
    throw new Error("Meteora swap: no bin arrays for this direction — pool has no liquidity");
  }

  const quote = pool.swapQuote(inAmount, swapForY, new BN(100), binArrays, true);

  // minOutAmount undefined → BN crash inside pool.swap; treat as no-liquidity.
  if (!quote || !quote.minOutAmount || quote.consumedInAmount.isZero()) {
    throw new Error("Meteora swap quote returned zero or invalid amounts — pool has insufficient liquidity");
  }

  const swapTx = await pool.swap({
    inToken:         inputPubkey,
    outToken,
    inAmount,
    minOutAmount:    quote.minOutAmount,
    lbPair:          pool.pubkey,
    user:            keypair.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });

  const txList = Array.isArray(swapTx) ? swapTx : [swapTx];
  let lastSig = null;
  for (const tx of txList) {
    lastSig = await sendAndConfirmTransaction(conn, tx, [keypair], {
      commitment:    "confirmed",
      skipPreflight: true,
    });
  }

  return {
    sig:          lastSig,
    inputAmount:  rawAmount,
    outputAmount: quote.outAmount.toString(),
  };
}
