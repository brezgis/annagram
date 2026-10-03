import { Model, loadNovelty } from "./engine.js";

const $ = (sel) => document.querySelector(sel);
const output = $("#output"), promptEl = $("#prompt"), randBtn = $("#rand");
const anna = $("#anna");

const PACE = 22; // ms per letter
// Shading spans the context lengths that actually occur (almost every letter has ≥ 4).
const SHADE_FROM = 4;
// Glitter = signature Anna: the full 10-letter sequence appears ≥ this many times in her text.
const SIGNATURE = 8;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let model, run = 0, steps = [];

async function getModel() {
  if (model) return model;
  const [data, novelty] = await Promise.all([fetchJSON("models/char.json"), fetchJSON("models/novelty.json")]);
  return (model = new Model(data, loadNovelty(novelty)));
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// The top of Anna's head rocks on alternating hinges while she talks.
// Throttled so letter-by-letter printing doesn't turn into a blur.
let side = false, lastFlap = 0;
function talk() {
  const now = performance.now();
  if (now - lastFlap < 110) return;
  lastFlap = now;
  side = !side;
  anna.classList.toggle("talk-l", side);
  anna.classList.toggle("talk-r", !side);
}
function hush() {
  anna.classList.remove("talk-l", "talk-r");
}

// ---- pixel tails, drawn on the same unit grid as everything else ----

// A wedge LEN units long whose opening is 2·HALF+1 units tall, with a 2-unit outline.
// Its last 2 columns sit on the bubble's border and paint over it with the fill.
const TAIL = { len: 12, half: 5, line: 2 };
function drawTail(svg, vertical) {
  const { len, half, line } = TAIL;
  const rows = 2 * half + 1 + 2 * line, center = half + line;
  const inside = (x, y) => Math.abs(y - center) <= Math.floor((half * x) / (len - 1));
  const rects = [];
  for (let x = 0; x < len; x++) {
    for (let y = 0; y < rows; y++) {
      let cls = null;
      if (inside(x, y)) cls = "f";
      else {
        for (let dx = -line; dx <= line && !cls; dx++)
          for (let dy = -line; dy <= line && !cls; dy++)
            if (x + dx >= 0 && x + dx < len && inside(x + dx, y + dy)) cls = "o";
      }
      if (cls) {
        const [rx, ry] = vertical ? [y, x] : [x, y];
        rects.push(`<rect class="${cls}" x="${rx}" y="${ry}" width="1.02" height="1.02"/>`);
      }
    }
  }
  const [w, h] = vertical ? [rows, len] : [len, rows];
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.style.width = `calc(${w} * var(--u))`;
  svg.style.height = `calc(${h} * var(--u))`;
  // CSS puts it flush against the padding edge, so its last 2 columns (rows, when
  // vertical) land on the bubble's 2-unit border and paint the opening over it.
  svg.innerHTML = rects.join("");
}
drawTail($(".tail-side"), false);
drawTail($(".tail-up"), true);

// ---- title: touch a letter and the whole letter shimmers pink, then fades back ----

const glitterCanvas = $("#glitter");
const LOGO_W = 232, LOGO_H = 45;
const FADE = 1 / 150;     // glow lost per frame (~2.5s back to ink)
const PINKS = [[255, 95, 174], [255, 20, 147], [255, 150, 205], [230, 40, 150], [255, 120, 190], [214, 24, 127]];
const phase = Float32Array.from({ length: LOGO_W * LOGO_H }, () => Math.random() * PINKS.length);
let letters = [], glowFrame = 0;   // [{ x0, x1, pixels, heat }]

// Split the ink logo into letters: runs of columns that contain ink.
const logoImg = new Image();
logoImg.src = "assets/logo-ink.png";
logoImg.decode().then(() => {
  const c = document.createElement("canvas");
  c.width = LOGO_W; c.height = LOGO_H;
  const g = c.getContext("2d");
  g.drawImage(logoImg, 0, 0);
  const d = g.getImageData(0, 0, LOGO_W, LOGO_H).data;
  const ink = (x, y) => d[4 * (y * LOGO_W + x) + 3] > 0;
  let cur = null;
  for (let x = 0; x < LOGO_W; x++) {
    const col = [];
    for (let y = 0; y < LOGO_H; y++) if (ink(x, y)) col.push(y * LOGO_W + x);
    if (col.length) {
      cur ??= { x0: x, x1: x, pixels: [], heat: 0 };
      cur.x1 = x;
      cur.pixels.push(...col);
    } else if (cur) {
      letters.push(cur);
      cur = null;
    }
  }
  if (cur) letters.push(cur);
}).catch(() => {});

glitterCanvas.parentElement.addEventListener("pointermove", (e) => {
  const r = glitterCanvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * LOGO_W;
  // Anywhere in a letter's column span lights the whole letter (generous to hit).
  const hit = letters.find((L) => x >= L.x0 - 2 && x <= L.x1 + 2);
  if (!hit) return;
  hit.heat = 1;
  if (!glowFrame) glowFrame = requestAnimationFrame(drawGlow);
});

function drawGlow(t) {
  const g = glitterCanvas.getContext("2d");
  const img = g.createImageData(LOGO_W, LOGO_H);
  const out = img.data;
  const still = reducedMotion.matches;
  let live = false;
  for (const L of letters) {
    if (L.heat <= 0) continue;
    live = true;
    const alpha = Math.round(255 * Math.min(1, L.heat * 1.5)); // holds full pink, then fades to ink
    for (const i of L.pixels) {
      // Each pixel drifts through the pinks at its own phase, so the letter shimmers.
      const [r, gr, b] = PINKS[Math.floor(phase[i] + (still ? 0 : t / 140)) % PINKS.length];
      const sparkle = !still && Math.random() < 0.015 * L.heat;
      const o = 4 * i;
      out[o] = sparkle ? 255 : r;
      out[o + 1] = sparkle ? 255 : gr;
      out[o + 2] = sparkle ? 255 : b;
      out[o + 3] = alpha;
    }
    L.heat = Math.max(0, L.heat - FADE);
  }
  g.putImageData(img, 0, 0);
  glowFrame = live ? requestAnimationFrame(drawGlow) : 0;
}

// ---- talking ----

async function write(promptText = "") {
  const id = ++run;
  output.replaceChildren();
  steps = [];
  let m;
  try {
    m = await getModel();
  } catch {
    output.textContent = "The model files didn't load. Reload the page to try again.";
    return;
  }
  const pace = reducedMotion.matches ? 0 : PACE;

  for (const ev of m.generate(promptText)) {
    if (id !== run) return; // a newer run took over
    if (ev.type === "prompt" && promptText) {
      const given = document.createElement("span");
      given.className = "given";
      given.textContent = promptText;
      output.append(given);
    } else if (ev.type === "token") {
      renderToken(ev);
      if (ev.id !== 1) talk();
      if (pace) await new Promise((r) => setTimeout(r, pace));
    } else if (ev.type === "rewind") {
      for (const s of steps.splice(ev.to)) s.nodes.forEach((n) => n.remove());
    }
  }
  if (id === run) hush();
}

function renderToken(step) {
  const nodes = [];
  if (step.id !== 1) { // <eos> prints nothing
    const piece = model.piece(step.id);
    const tok = document.createElement("span");
    tok.className = "tok";
    tok.style.setProperty("--a", shade(step.matched).toFixed(3));
    if (isSignature(step)) tok.classList.add("sparkle");
    if (piece.redacted) {
      tok.classList.add("redacted");
      tok.style.setProperty("--len", Math.max(3, Math.min(9, piece.redacted.length + 1)));
      tok.setAttribute("aria-label", `redacted ${piece.redacted}`);
    } else {
      tok.textContent = piece.text;
    }
    nodes.push(tok);
  }
  output.append(...nodes);
  steps.push({ nodes }); // kept only so novelty rewinds can erase letters
}

function shade(k) {
  return Math.min(Math.max((k - SHADE_FROM) / (model.order - SHADE_FROM), 0), 1);
}

function isSignature(step) {
  const top = step.levels.at(-1);
  if (!top?.found || top.k !== model.order) return false;
  const j = top.e.w.indexOf(step.id);
  return j >= 0 && top.e.raw[j] >= SIGNATURE;
}

// ---- wiring ----

randBtn.addEventListener("click", () => write());
anna.addEventListener("click", () => write());
anna.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); write(); }
});
// Space anywhere talks, unless you're typing or on a control that uses space itself.
addEventListener("keydown", (e) => {
  if (e.key !== " " || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.("input, textarea, select, button, [contenteditable], [role=button]")) return;
  e.preventDefault();
  write();
});
promptEl.addEventListener("keydown", (e) => { if (e.key === "Enter") write(promptEl.value.trim()); });

write();
