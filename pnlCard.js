/**
 * PnL close card — background win.png (profit) / lose.png (loss), data panel
 * drawn on top. Ported from itsmepure/DLMM-manual-byPureXBT's card renderer,
 * adapted to this project's manager.js close-notification fields.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _fontReady = false;
function ensureFonts() {
  if (_fontReady) return;
  // System DejaVu Sans — no bundled font file needed.
  const p = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  try { if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, "CardFont"); } catch { /* fall back to default */ }
  _fontReady = true;
}
const FONT = "CardFont, sans-serif";

const W = 1200, H = 675;
const GREEN = "#20C997";
const RED = "#FF4D6D";

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// cover-fit: fill the whole canvas without distortion (crop overflow)
function drawCover(ctx, img) {
  const scale = Math.max(W / img.width, H / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/**
 * renderPnlCard({ win, symbol, detail, pnlUsd, pnlSol, pnlPct, closedAt })
 * -> Buffer PNG. Throws if background/render fails — caller should fall back
 * to a plain text message.
 */
export async function renderPnlCard({ win, symbol, detail, pnlUsd, pnlSol, pnlPct, closedAt }) {
  ensureFonts();
  const bgPath = path.join(__dirname, win ? "win.png" : "lose.png");
  const img = await loadImage(bgPath);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  drawCover(ctx, img);

  ctx.fillStyle = "rgba(6,6,12,0.18)";
  ctx.fillRect(0, 0, W, H);

  const px = 42, py = 42, pw = 560, ph = 330;
  roundRect(ctx, px, py, pw, ph, 22);
  ctx.fillStyle = "rgba(10,10,18,0.78)";
  ctx.fill();
  ctx.strokeStyle = win ? "rgba(32,201,151,0.55)" : "rgba(255,77,109,0.55)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const color = win ? GREEN : RED;
  let y = py + 56;

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#9AA0B4";
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText("exitbot-evan".toUpperCase(), px + 32, y);

  y += 52;
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `800 40px ${FONT}`;
  ctx.fillText(String(symbol || "?").slice(0, 20), px + 32, y);

  y += 78;
  ctx.fillStyle = color;
  ctx.font = `800 60px ${FONT}`;
  const pctText = pnlPct != null && Number.isFinite(pnlPct) ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "n/a";
  ctx.fillText(pctText, px + 32, y);

  y += 48;
  ctx.fillStyle = "#C9CDDC";
  ctx.font = `700 30px ${FONT}`;
  const moneyBits = [
    pnlUsd != null && Number.isFinite(pnlUsd) ? `${pnlUsd >= 0 ? "+" : "-"}$${Math.abs(pnlUsd).toFixed(2)}` : null,
    pnlSol != null && Number.isFinite(pnlSol) ? `${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL` : null,
  ].filter(Boolean).join("  ·  ");
  if (moneyBits) ctx.fillText(moneyBits, px + 32, y);

  y += 46;
  ctx.fillStyle = "#9AA0B4";
  ctx.font = `600 22px ${FONT}`;
  if (detail) ctx.fillText(String(detail).slice(0, 46), px + 32, y);

  ctx.fillStyle = color;
  ctx.font = `800 54px ${FONT}`;
  const label = win ? "PROFIT" : "LOSS";
  const lw = ctx.measureText(label).width;
  ctx.fillText(label, W - lw - 48, H - 88);

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = `600 20px ${FONT}`;
  const ts = closedAt || new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const tw = ctx.measureText(ts).width;
  ctx.fillText(ts, W - tw - 48, H - 44);

  return canvas.toBuffer("image/png");
}
