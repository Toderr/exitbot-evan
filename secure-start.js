/**
 * Decrypts SOLANA_PRIVATE_KEY from secrets/wallet.key.age into process.env
 * (memory only, never written to disk) before loading the bot. The age
 * identity file stays outside the repo, chmod 600.
 *
 * dotenv (loaded inside index.js via "dotenv/config") does not override env
 * vars that are already set, so setting process.env here takes precedence
 * over whatever (or nothing) is in .env. process.argv is preserved through
 * the dynamic import, so flags like --once still work.
 */
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGE_IDENTITY = process.env.AGE_IDENTITY_FILE ?? path.join(os.homedir(), ".config/age/exitbot-evan.key");
const ENCRYPTED_KEY = path.join(__dirname, "secrets", "wallet.key.age");

try {
  const key = execFileSync("age", ["-d", "-i", AGE_IDENTITY, ENCRYPTED_KEY], { encoding: "utf8" }).trim();
  if (!key) throw new Error("decrypted key is empty");
  process.env.SOLANA_PRIVATE_KEY = key;
} catch (e) {
  console.error(`Failed to decrypt SOLANA_PRIVATE_KEY: ${e.message}`);
  console.error(`Expected age identity at ${AGE_IDENTITY} and encrypted key at ${ENCRYPTED_KEY}`);
  console.error(`Run scripts/encrypt-key.sh first to (re)create the encrypted key.`);
  process.exit(1);
}

await import("./index.js");
