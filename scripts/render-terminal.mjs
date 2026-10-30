// Renders real canfail output (with ANSI colors) as an SVG terminal window for the README.
// Usage: node scripts/render-terminal.mjs <out.svg> <title> <prompt> -- <command...>
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [out, title, prompt, sep, cmd, ...args] = process.argv.slice(2);
if (sep !== "--") throw new Error("usage: render-terminal.mjs <out.svg> <title> <prompt> -- <command...>");
const run = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "" } });
const text = (run.stdout + run.stderr).replace(/\n+$/, "");

const PALETTE = { 31: "#ff7b72", 32: "#3fb950", 33: "#d29922", 36: "#58a6ff" };
const FG = "#c9d1d9";
const CHAR = 7.83; // width of one 13px monospace character
const LINE = 19;
const PAD = 22;
const TOP = 46;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function parse(line) {
  const spans = [];
  let style = {};
  let col = 0;
  for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
    const m = /^\x1b\[([\d;]*)m$/.exec(part);
    if (m) {
      for (const code of (m[1] || "0").split(";").map(Number)) {
        if (code === 0) style = {};
        else if (code === 1) style = { ...style, bold: true };
        else if (code === 2) style = { ...style, dim: true };
        else if (PALETTE[code]) style = { ...style, color: PALETTE[code] };
      }
    } else if (part) {
      spans.push({ text: part, col, ...style });
      col += [...part].length;
    }
  }
  return { spans, width: col };
}

const lines = [`$ ${prompt}`, "", ...text.split("\n")].map(parse);
lines[0].spans = [{ text: "$ ", col: 0, color: "#3fb950", bold: true }, { text: prompt, col: 2, bold: true }];
const cols = Math.max(...lines.map((l) => l.width));
const width = Math.ceil(PAD * 2 + cols * CHAR);
const height = TOP + lines.length * LINE + PAD;

const body = lines
  .map((l, i) => {
    const y = TOP + (i + 1) * LINE - 5;
    const tspans = l.spans
      .map((s) => {
        // Spans flow one after the other, so columns line up in any monospace font.
        const attrs = [];
        if (s.color) attrs.push(`fill="${s.color}"`);
        if (s.bold) attrs.push(`font-weight="700"`);
        if (s.dim) attrs.push(`fill-opacity="0.55"`);
        return attrs.length ? `<tspan ${attrs.join(" ")}>${esc(s.text)}</tspan>` : esc(s.text);
      })
      .join("");
    return `  <text x="${PAD}" y="${y}" xml:space="preserve">${tspans}</text>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
  <circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="22" text-anchor="middle" fill="#8b949e" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">${esc(title)}</text>
  <line x1="0" y1="34" x2="${width}" y2="34" stroke="#21262d"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="13" fill="${FG}">
${body}
  </g>
</svg>
`;
writeFileSync(out, svg);
console.log(`${out}: ${lines.length} lines, ${width}x${height}`);
