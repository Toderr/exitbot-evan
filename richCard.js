/**
 * Shared "rich card" layout for sendRichMessage alerts (see telegram.js
 * sendRichHTML). Mirrors the reference style: emoji+bold heading, bold
 * subtitle, italic detail line, a bordered/striped Metric|Value table, link
 * lines, a collapsible mint-CA row, and a small dim footer caption.
 */
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function card({ emoji, title, subtitle, detail, headers = ["Metric", "Value"], rows = [], body, links = [], mint, footer }) {
  const parts = [];
  parts.push(`<h3>${emoji ? `${emoji} ` : ""}${title}</h3>`);
  if (subtitle) parts.push(`<p>${subtitle}</p>`);
  if (detail) parts.push(`<p><i>${detail}</i></p>`);
  if (rows.length) {
    const head = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
    const rowsHtml = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
    parts.push(`<table bordered striped>${head}${rowsHtml}</table>`);
  }
  if (body) parts.push(`<p>${body}</p>`);
  for (const link of links) parts.push(`<p>${link}</p>`);
  if (mint) parts.push(`<details><summary><b>Mint CA</b> · tap to copy</summary><code>${mint}</code></details>`);
  if (footer) parts.push(`<footer>${footer}</footer>`);
  return parts.join("\n\n");
}
