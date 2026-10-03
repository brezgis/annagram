import { Model, loadNovelty } from "./engine.js";

const $ = (sel) => document.querySelector(sel);
const output = $("#output"), promptEl = $("#prompt"), randBtn = $("#rand");
const anna = $("#anna");

const PACE = 48; // ms per letter
// Linger a little after punctuation, like someone typing rather than a printer.
const PAUSE = { ".": 6, "!": 6, "?": 6, ",": 3, ";": 3, ":": 3, " ": 1.3 };
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
// a n [n] a [g r a m]: the pink letters spell n-gram (and the second n is the one
// that turns "anagram" into "annagram").
const PINK_LETTERS = new Set([2, 4, 5, 6, 7]);
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const restingPink = () => (darkScheme.matches ? [255, 95, 174] : [214, 24, 127]);

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
  drawGlow(performance.now());
}).catch(() => {});
darkScheme.addEventListener("change", () => { if (!glowFrame) drawGlow(performance.now()); });

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
  for (const [n, L] of letters.entries()) {
    if (L.heat <= 0) {
      if (PINK_LETTERS.has(n)) for (const i of L.pixels) out.set([...restingPink(), 255], 4 * i);
      continue;
    }
    live = true;
    const glow = Math.min(1, L.heat * 1.5); // holds full shimmer, then fades back
    // Most letters fade back to the ink underneath; the pink n fades back to its resting pink.
    const rest = PINK_LETTERS.has(n) ? restingPink() : null;
    for (const i of L.pixels) {
      // Each pixel drifts through the pinks at its own phase, so the letter shimmers.
      let [r, gr, b] = PINKS[Math.floor(phase[i] + (still ? 0 : t / 140)) % PINKS.length];
      if (!still && Math.random() < 0.015 * L.heat) r = gr = b = 255;
      const o = 4 * i;
      if (rest) out.set([rest[0] + (r - rest[0]) * glow, rest[1] + (gr - rest[1]) * glow, rest[2] + (b - rest[2]) * glow, 255], o);
      else out.set([r, gr, b, Math.round(255 * glow)], o);
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

  let lastPick = null;
  $(".controls").dataset.mode = promptText ? "given" : "rand";
  for (const ev of m.generate(promptText)) {
    if (id !== run) return; // a newer run took over
    if (ev.type === "prompt" && promptText) {
      const given = document.createElement("span");
      given.className = "given";
      given.textContent = promptText;
      output.append(given);
    } else if (ev.type === "token") {
      renderToken(ev);
      if (ev.id !== 1) {
        talk();
        lastPick = inspectData(ev);
        drawFigure(lastPick); // the bars twitch along as she types
      }
      if (pace) await new Promise((r) => setTimeout(r, pace * (PAUSE[model.vocab[ev.id]] ?? 1)));
    } else if (ev.type === "rewind") {
      for (const s of steps.splice(ev.to)) s.nodes.forEach((n) => n.remove());
    }
  }
  if (id === run) {
    hush();
    if (lastPick) drawFigure((lastShown = lastPick));
  }
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
  const index = steps.length;
  steps.push({ nodes });
  if (step.id !== 1) {
    const tok = nodes[0], data = inspectData(step);
    // Hovering shows the whole n-gram: the context h (the 9 letters before) and c itself.
    const inspect = () => {
      clearInspect();
      for (let j = Math.max(0, index - (model.order - 1)); j < index; j++) steps[j]?.nodes[0]?.classList.add("in-ctx");
      tok.classList.add("inspected");
      drawFigure(data);
    };
    tok.addEventListener("pointerenter", inspect);
    tok.addEventListener("click", inspect);
  }
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

// ---- figure: the distribution behind the last letter ----

const figBars = $("#fig-bars"), figMath = $("#fig-math"), figLetter = $("#fig-letter"), figClass = $("#fig-class");

// What the inspector needs from one sampling step: the distribution, the context, and
// how much of Anna backed the pick (longest matching order k, and N(h_k c) there).
function inspectData(step) {
  let count = 0;
  for (const L of step.levels) {
    if (!L.found || L.k !== step.matched) continue;
    const j = L.e.w.indexOf(step.id);
    if (j >= 0) count = L.e.raw[j];
  }
  const kind = isSignature(step) ? "sig" : step.matched >= model.order - 1 ? "known" : "guess";
  return { id: step.id, p: step.p, ctx: step.ctx, matched: step.matched, count, kind };
}
const KIND_NAME = { guess: "guess", known: "familiar", sig: "signature" };
let lastShown = null;
function shown(id) {
  if (id === 1) return "¶";
  const piece = model.piece(id);
  return piece.redacted ? "▇" : piece.text === " " ? "␣" : piece.text;
}
function drawFigure(step) {
  const ctx = step.ctx.slice(-(model.order - 1)).filter((i) => i > 1);
  figMath.innerHTML = "";
  figMath.append("P(c | h = ", Object.assign(document.createElement("b"), { textContent: ctx.length ? `“${ctx.map(shown).join("")}”` : "⟨start⟩" }), ")");
  figLetter.textContent = shown(step.id);
  figLetter.className = step.kind === "sig" ? "sig" : "";
  figBars.classList.toggle("sig", step.kind === "sig");
  figClass.replaceChildren(
    Object.assign(document.createElement("b"), { className: step.kind, textContent: KIND_NAME[step.kind] }),
    step.matched > 1 ? ` · seen ${step.count}× as a ${step.matched}-letter n-gram` : " · no context matched");
  const top = [...step.p.keys()].filter((i) => i !== 0).sort((a, b) => step.p[b] - step.p[a]).slice(0, 6);
  if (!top.includes(step.id)) top[top.length - 1] = step.id; // always show the one she picked
  const max = Math.max(...top.map((i) => step.p[i]));
  figBars.replaceChildren(...top.map((i) => {
    const row = document.createElement("div");
    row.className = "bar-row" + (i === step.id ? " picked" : "");
    row.setAttribute("role", "listitem");
    const pct = 100 * step.p[i];
    const label = pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct.toFixed(2);
    row.title = `“${shown(i)}”: ${label}%${i === step.id ? " (picked)" : ""}`;
    const ch = Object.assign(document.createElement("span"), { className: "bar-char", textContent: shown(i) });
    const bar = Object.assign(document.createElement("span"), { className: "bar" });
    bar.style.width = `${(100 * step.p[i]) / max}%`;
    const val = Object.assign(document.createElement("span"), { className: "bar-val", textContent: `${label}%` });
    row.append(ch, bar, val);
    return row;
  }));
}

function clearInspect() {
  for (const t of output.querySelectorAll(".inspected, .in-ctx")) t.classList.remove("inspected", "in-ctx");
}
output.addEventListener("pointerleave", () => {
  clearInspect();
  if (lastShown) drawFigure(lastShown);
});

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
