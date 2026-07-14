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
 * Query the token account balance for a given mint + owner via RPC.
 * Returns the raw u64 amount (string) or null if no account found.
 */
async function getTokenBalance(conn, ownerPubkey, mintPubkey) {
  const { PublicKey } = require("@solana/web3.js");
  const accounts = await conn.getParsedTokenAccountsByOwner(ownerPubkey, {
    mint: new PublicKey(mintPubkey),
  });
  const amt = accounts?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
  return amt ?? null;
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
 * @returns {Promise<{ sig: string, inputAmount: string, outputAmount: string }>}
 */
export async function swapAllToSol({ conn, keypair, inputMint, outputMint = SOL_MINT, slippageBps = 100 }) {
  const { VersionedTransaction } = require("@solana/web3.js");

  // RPC may lag behind the confirmed withdraw tx — retry up to 10×, 4s apart
  // (40s total). A 5×3s=15s window proved too short under load: the withdrawn
  // tokens silently stranded in the wallet (manager logged "no swap needed"
  // and dropped the position from state, leaving real $ unswapped).
  let rawAmount = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    rawAmount = await getTokenBalance(conn, keypair.publicKey, inputMint);
    if (rawAmount && rawAmount !== "0") break;
    if (attempt < 10) await new Promise((r) => setTimeout(r, 4000));
  }
  if (!rawAmount || rawAmount === "0") {
    throw new Error(`No ${inputMint.slice(0, 8)}… balance to swap`);
  }

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
          outputAmount: quote?.outAmount ?? "?",
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
 */
export async function swapAllToSolFromKey({ rpcUrl, privateKeyBase58, inputMint, outputMint = SOL_MINT, slippageBps = 100 }) {
  const { Connection, Keypair } = require("@solana/web3.js");
  const secretKey = bs58.default?.decode
    ? bs58.default.decode(privateKeyBase58)
    : bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  const conn    = new Connection(rpcUrl, "confirmed");
  return swapAllToSol({ conn, keypair, inputMint, outputMint, slippageBps });
}
