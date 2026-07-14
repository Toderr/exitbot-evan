import fs from "fs";
import path from "path";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function log(category, message) {
  const level = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : "info";

  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${category.toUpperCase()}] ${message}`;

  console.log(line);

  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `exitbot-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
}
