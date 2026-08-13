/**
 * Jupiter Swap API v6 client.
 *
 * Swaps an SPL token to SOL (or any mint pair) using Jupiter's quote+swap
 * REST endpoints. No SDK required — only @solana/web3.js for signing.
 *
 * Flow:
 *   1. GET /v6/quote          — best route for inputMint → outputMint
 *   2. POST /v6/swap          — serialised VersionedTransaction
 *   3. Sign + sendRawTransaction via the provided connection
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const bs58    = require("bs58");

const JUPITER_API = "https://api.jup.ag/swap/v1";
const SOL_MINT    = "So11111111111111111111111111111111111111112";

async function fetchWithRetry(fn, attempts = 5, delayMs = 4000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function apiGet(path) {
  return fetchWithRetry(async () => {
    const res = await fetch(JUPITER_API + path, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter GET ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  });
}

async function apiPost(path, body) {
  return fetchWithRetry(async () => {
    const res = await fetch(JUPITER_API + path, {
      method:  "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jupiter POST ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  });
}

/**
 * Query the token balance for a given mint + owner via RPC.
 *
 * Sums every token account the owner holds for the mint (a wallet can end up
 * with more than one ATA for the same mint — e.g. an extra account created by
 * a router — and reading only value[0] would silently under-count).
 * Returns the raw u64 total as a string ("0" when no accounts exist).
 */
export async function getTokenBalance(conn, ownerPubkey, mintPubkey) {
  const { PublicKey } = require("@solana/web3.js");
  const accounts = await conn.getParsedTokenAccountsByOwner(ownerPubkey, {
    mint: new PublicKey(mintPubkey),
  });
  let total = 0n;
  for (const acc of accounts?.value ?? []) {
    const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amt) total += BigInt(amt);
  }
  return total.toString();
}

/**
 * Read a wallet's raw token balance from credentials alone.
 * Used by the manager to snapshot the pre-withdraw balance (see `baselineRaw`).
 */
export async function getTokenBalanceFromKey({ rpcUrl, ownerAddress, mint }) {
  const { Connection, PublicKey } = require("@solana/web3.js");
  const conn = new Connection(rpcUrl, "confirmed");
  return getTokenBalance(conn, new PublicKey(ownerAddress), mint);
}

/**
 * Swap all of `inputMint` held by `keypair` to SOL using Jupiter.
 *
 * @param {object} opts
 * @param {object} opts.conn           — web3.js Connection
 * @param {object} opts.keypair        — web3.js Keypair (signer)
 * @param {string} opts.inputMint      — SPL token mint to swap from
 * @param {string} [opts.outputMint]   — default: SOL
 * @param {number} [opts.slippageBps]  — default: 100 (1%)
 * @param {string} [opts.baselineRaw]  — raw balance observed *before* the withdraw
 * @returns {Promise<{ sig: string, inputAmount: string, outputAmount: string }>}
 */
export async function swapAllToSol({ conn, keypair, inputMint, outputMint = SOL_MINT, slippageBps = 100, baselineRaw = "0" }) {
  const rawAmount = await waitForWithdrawnBalance({ conn, keypair, inputMint, baselineRaw });
  if (rawAmount === 0n) {
    throw new Error(`No ${inputMint.slice(0, 8)}… balance to swap`);
  }

  // Swap in rounds, sweeping whatever is left after each one. A single round
  // can leave tokens behind when the balance grew between the read and the
  // swap (a second withdraw tx landing, RPC lag), and stranded tokens are real
  // money — so re-read and swap again while a meaningful remainder is left.
  const MAX_ROUNDS = 3;
  let amount = rawAmount;
  let totalIn = 0n, totalOut = 0n, lastSig = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const result = await swapExactAmount({ conn, keypair, inputMint, outputMint, slippageBps, rawAmount: amount.toString() });
    totalIn  += amount;
    totalOut += BigInt(result.outputAmount ?? 0);
    lastSig   = result.sig;
    if (round === MAX_ROUNDS) break;

    const remaining = await settleBalanceAfterSwap({ conn, keypair, inputMint, before: amount });
    // Ignore trailing dust (<1% of what we just sold) — not worth another fee.
    if (remaining === 0n || remaining * 100n < amount) break;
    console.warn(`[jupiter] ${remaining} ${inputMint.slice(0, 8)}… left after swap — sweeping (round ${round + 1})`);
    amount = remaining;
  }

  return { sig: lastSig, inputAmount: totalIn.toString(), outputAmount: totalOut.toString() };
}

/**
 * Wait for the post-withdraw token balance to show up.
 *
 * Polls up to 10× / 4s apart (40s). The balance must exceed `baselineRaw` —
 * what the wallet already held before the withdraw — otherwise a stale RPC
 * read of leftover dust satisfies the poll instantly and only the dust gets
 * swapped while the withdrawn tokens sit stranded in the wallet (this happened:
 * a 146k-token position sold 0.02 tokens for 846 lamports).
 *
 * If the poll expires with the balance still at/below baseline, whatever is
 * actually there is returned anyway — sweeping stale dust beats sweeping
 * nothing, and an all-SOL position simply reads 0 and is reported as such.
 */
async function waitForWithdrawnBalance({ conn, keypair, inputMint, baselineRaw = "0" }) {
  const baseline = BigInt(baselineRaw || "0");
  let current = 0n;
  for (let attempt = 1; attempt <= 10; attempt++) {
    current = BigInt(await getTokenBalance(conn, keypair.publicKey, inputMint));
    if (current > baseline) return current;
    if (attempt < 10) await new Promise((r) => setTimeout(r, 4000));
  }
  if (current > 0n) {
    console.warn(`[jupiter] balance for ${inputMint.slice(0, 8)}… never rose above the pre-withdraw ${baseline} — swapping the ${current} present`);
  }
  return current;
}

/**
 * After a confirmed swap, wait briefly for the RPC to reflect the spend, then
 * report what is left. Without the wait the pre-swap balance reads back
 * unchanged and the sweep would re-sell tokens that are already gone.
 */
async function settleBalanceAfterSwap({ conn, keypair, inputMint, before }) {
  let remaining = before;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    remaining = BigInt(await getTokenBalance(conn, keypair.publicKey, inputMint));
    if (remaining < before) break;
  }
  return remaining < before ? remaining : 0n;
}

/**
 * Swap an exact raw amount of `inputMint` to `outputMint`, with retries.
 */
async function swapExactAmount({ conn, keypair, inputMint, outputMint, slippageBps, rawAmount }) {
  const { VersionedTransaction } = require("@solana/web3.js");

  // Build + send + confirm as a retried unit. Each attempt fetches a FRESH
  // Jupiter swap tx (with a new embedded blockhash), so two previously-common
  // final failures self-heal on the next try:
  //   • "block height exceeded" — the prior attempt's blockhash expired before
  //     confirmation (network congestion); a fresh tx gets a fresh blockhash.
  //   • "fetch failed" — a transient RPC/network blip on getLatestBlockhash /
  //     sendRawTransaction (these RPC calls were never wrapped by apiGet's retry).
  // A higher priority fee (capped) improves landing odds under congestion.
  //
  // Slippage escalation: after 5 failed attempts at the current slippage,
  // bump it by 1% (100bps) and try another 5 — up to 3 tiers total (max +2%).
  // Most post-close swap failures on illiquid tokens are slippage-tolerance
  // exceeded ("0x1771"), so widening tolerance lets the swap land instead of
  // leaving tokens stranded after every retry exhausts at the same slippage.
  const sendAttempts = 5;
  const slippageTiers = 3;
  const slippageStepBps = 100;
  let lastErr;
  for (let tier = 0; tier < slippageTiers; tier++) {
    const tierSlippageBps = slippageBps + tier * slippageStepBps;
    if (tier > 0) {
      console.warn(`[jupiter] swap still failing after ${sendAttempts} attempts — raising slippage to ${tierSlippageBps / 100}%`);
    }
    for (let attempt = 1; attempt <= sendAttempts; attempt++) {
      try {
        const quote = await apiGet(
          `/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&slippageBps=${tierSlippageBps}&onlyDirectRoutes=false`
        );

        const { swapTransaction } = await apiPost("/swap", {
          quoteResponse:           quote,
          userPublicKey:           keypair.publicKey.toBase58(),
          wrapAndUnwrapSol:        true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" },
          },
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
        // Fetch lastValidBlockHeight before signing — gives us a valid upper-bound
        // for blockhash-aware confirmation (Jupiter embeds its own blockhash in the tx).
        const { lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
        tx.sign([keypair]);

        const sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,   // Jupiter pre-validates server-side; skip redundant sim
          maxRetries:    0,      // we retry at the application level (fresh blockhash)
        });
        await conn.confirmTransaction(
          { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
          "confirmed",
        );

        return {
          sig,
          inputAmount:  rawAmount,
          outputAmount: quote?.outAmount ?? "0",
        };
      } catch (e) {
        lastErr = e;
        const isLastAttempt = tier === slippageTiers - 1 && attempt === sendAttempts;
        if (!isLastAttempt) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

/**
 * Convenience wrapper — accepts raw credentials rather than pre-built objects.
 * Used by the manager bot after a TP withdrawal to swap recovered tokens to SOL.
 *
 * @param {object} opts
 * @param {string} opts.rpcUrl           — Solana RPC URL
 * @param {string} opts.privateKeyBase58 — wallet private key as base58 string
 * @param {string} opts.inputMint        — SPL token mint to swap from
 * @param {string} [opts.outputMint]     — default: SOL
 * @param {number} [opts.slippageBps]    — default: 100 (1%)
 * @param {string} [opts.baselineRaw]    — raw balance observed before the withdraw
 */
export async function swapAllToSolFromKey({ rpcUrl, privateKeyBase58, inputMint, outputMint = SOL_MINT, slippageBps = 100, baselineRaw = "0" }) {
  const { Connection, Keypair } = require("@solana/web3.js");
  const secretKey = bs58.default?.decode
    ? bs58.default.decode(privateKeyBase58)
    : bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  const conn    = new Connection(rpcUrl, "confirmed");
  return swapAllToSol({ conn, keypair, inputMint, outputMint, slippageBps, baselineRaw });
}
