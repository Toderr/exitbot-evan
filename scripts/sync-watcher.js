/**
 * Polls exitbot-evan's shared bot-logic files for mtime changes and re-syncs
 * every sibling exit-bot (exitbot-papa, exitbot-mama, exitbot-catey, ...)
 * via sync-siblings.sh whenever any of them change. Polling instead of a
 * filesystem watch because this box has no inotify-tools installed and
 * Node's recursive fs.watch isn't reliable on Linux.
 *
 * Wallet-specific files (.env, secrets/, state/, logs/) are never watched —
 * see sync-siblings.sh's exclude list for what actually gets copied, and its
 * SIBLINGS array for which clones receive the sync.
 */
import { execFileSync } from "child_process";
import { statSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const POLL_MS = 20_000;

const WATCH_FILES = [
  "index.js", "config.js", "manager.js", "telegram.js",
  "telegramListener.js", "logger.js", "secure-start.js", "package.json", "CLAUDE.md",
];
const WATCH_DIRS = ["api"];

function fingerprint() {
  const entries = [];
  for (const f of WATCH_FILES) {
    try { entries.push(`${f}:${statSync(path.join(ROOT, f)).mtimeMs}`); } catch { /* missing, skip */ }
  }
  for (const d of WATCH_DIRS) {
    let files;
    try { files = readdirSync(path.join(ROOT, d)); } catch { continue; }
    for (const f of files) {
      try { entries.push(`${d}/${f}:${statSync(path.join(ROOT, d, f)).mtimeMs}`); } catch { /* skip */ }
    }
  }
  return entries.sort().join("|");
}

let last = fingerprint();
console.log(`[sync-watcher] watching ${WATCH_FILES.length} file(s) + ${WATCH_DIRS.join(",")}/ in ${ROOT} — polling every ${POLL_MS / 1000}s`);

setInterval(() => {
  let current;
  try {
    current = fingerprint();
  } catch (e) {
    console.error(`[sync-watcher] fingerprint failed: ${e.message}`);
    return;
  }
  if (current !== last) {
    last = current;
    console.log("[sync-watcher] change detected — syncing to siblings");
    try {
      const out = execFileSync(path.join(__dirname, "sync-siblings.sh"), { encoding: "utf8" });
      console.log(out.trim());
    } catch (e) {
      console.error(`[sync-watcher] sync failed: ${e.message}`);
    }
  }
}, POLL_MS);
