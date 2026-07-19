/**
 * exitbot-evan — entry point.
 *
 * Usage:
 *   node index.js         — start command listener + SL/TP/OOR cron
 *   node index.js --once  — run one exit-check tick immediately and exit
 */
import "dotenv/config";
import cron from "node-cron";
import { log } from "./logger.js";
import { config } from "./config.js";
import { runExitCheck } from "./manager.js";
import { startListener } from "./telegramListener.js";
import bot from "./telegram.js";

const ONCE = process.argv.includes("--once");

let tickRunning = false;
let currentTickId = 0;

// A hung RPC call inside runExitCheck() (no built-in Solana RPC timeout) used
// to leave tickRunning stuck `true` forever, silently freezing every future
// tick. This watchdog force-recovers after config.tickWatchdogMs so a stall
// is bounded instead of permanent. tickId guards against the original,
// eventually-settling promise clobbering a *later* tick's state once the
// watchdog has already unblocked the cron.
async function tick() {
  if (tickRunning) {
    log("main", "Exit-check tick still running — skipping overlapping tick");
    return;
  }
  tickRunning = true;
  const tickId = ++currentTickId;

  const watchdog = setTimeout(() => {
    if (tickId !== currentTickId) return;
    log("main_error", `Exit-check tick stuck for over ${config.tickWatchdogMs}ms — forcing recovery so future ticks resume`);
    bot.sendMessage(
      `🚨 exitbot-evan: exit-check tick stuck for over ${config.tickWatchdogMs / 1000}s (hung RPC call) — forced recovery. Run /status and verify on-chain state for whatever position was being closed.`,
    ).catch(() => {});
    tickRunning = false;
  }, config.tickWatchdogMs);

  try {
    const result = await runExitCheck();
    if (result.positions > 0) {
      log("main", `Exit-check done — positions: ${result.positions}, closed: ${result.closed}`);
    }
  } catch (e) {
    log("main_error", `Exit-check failed: ${e.message}`);
    console.error(e);
    await bot.sendMessage(`🚨 exitbot-evan ERROR:\n${e.message}`);
  } finally {
    clearTimeout(watchdog);
    if (tickId === currentTickId) tickRunning = false;
  }
}

if (ONCE) {
  log("main", "Running one exit-check tick (--once mode)");
  await tick();
  process.exit(0);
} else {
  log("main", `Starting exitbot-evan — exit-check schedule: ${config.cronSchedule}`);
  startListener();
  cron.schedule(config.cronSchedule, tick);
  log("main", "Cron scheduled. Waiting for /scan to adopt positions...");
}
