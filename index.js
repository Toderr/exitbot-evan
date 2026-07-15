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
async function tick() {
  if (tickRunning) {
    log("main", "Exit-check tick still running — skipping overlapping tick");
    return;
  }
  tickRunning = true;
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
    tickRunning = false;
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
