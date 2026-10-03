// annagram engine: interpolated Kneser-Ney n-gram sampling over models built
// by scripts/build_model.py. No DOM here, so it runs in Node too.

export const SP = "▁"; // ▁ = "preceded by whitespace"
const BOS = 0, EOS = 1;
// Kept in sync with PRETOKEN in scripts/build_model.py.
const PRETOKEN = /<[a-z]{2,8}>|[\p{L}\p{M}](?:[\p{L}\p{M}\p{N}_'’-]*[\p{L}\p{M}\p{N}])?|\p{N}+(?:[.,:\/]\p{N}+)*|[^\p{L}\p{M}\p{N}_\s]+/gu;
const PLACEHOLDER = /^<[a-z]{2,8}>$/;

export const DEFAULTS = {
  order: null,          // null = model max
  temperature: 0.9,
  minP: 0.04,           // drop tokens below minP × the top token's probability
  spice: 0,             // 0..1: boost rare tokens by count^-spice
  repetition: 1.3,      // divide p of tokens used in the last `repWindow` tokens
  repWindow: 24,
  noRepeat: null,       // block repeating any n-gram of this size; null = per-model default
  novelty: true,        // refuse to quote ≥ window words verbatim from the corpus
  stall: 4,             // end after this many tokens in a row with only unigram support (0 = off)
  minTokens: null,      // suppress <eos> before this many tokens; null = per-model default
  maxTokens: null,
};

const PER_MODEL = {
  word: { noRepeat: 3, minTokens: 4, maxTokens: 70 },
  bpe: { noRepeat: 5, minTokens: 6, maxTokens: 110 },
  char: { noRepeat: 14, minTokens: 20, maxTokens: 420 },
};

export class Model {
  constructor(data, novelty) {
    Object.assign(this, data);
    this.V = this.vocab.length;
    this.ids = new Map(this.vocab.map((t, i) => [t, i]));
    // Per context: { w: Int32Array, raw: Int32Array, cont: Int32Array, sums }
    this.tables = data.tables.map((t) => {
      if (!t) return null;
      const m = new Map();
      for (const [ctx, flat] of Object.entries(t)) {
        const n = flat.length / 3;
        const e = { w: new Int32Array(n), raw: new Int32Array(n), cont: new Int32Array(n), rawSum: 0, contSum: 0 };
        for (let i = 0; i < n; i++) {
          e.w[i] = flat[3 * i]; e.raw[i] = flat[3 * i + 1]; e.cont[i] = flat[3 * i + 2];
          e.rawSum += e.raw[i]; e.contSum += e.cont[i];
        }
        m.set(ctx, e);
      }
      return m;
    });
    this.unigram = new Float64Array(this.V).fill(1);
    const u = this.tables[1].get("");
    for (let i = 0; i < u.w.length; i++) this.unigram[u.w[i]] = u.raw[i];
    if (this.merges) this.ranks = new Map(this.merges.map(([a, b], i) => [a + "\u0000" + b, i]));
    if (this.placeholders) this.placeholderOf = new Map(Object.entries(this.placeholders).map(([k, v]) => [v, k]));
    this.novelty = novelty;
  }

  // ---- tokenization ----

  pretokens(text) {
    const out = [];
    for (const m of text.matchAll(PRETOKEN)) {
      out.push([m[0], m.index === 0 || /\s/.test(text[m.index - 1])]);
    }
    return out;
  }

  encode(text) {
    text = text.split(/\s+/).filter(Boolean).join(" ");
    let toks;
    if (this.name === "word") {
      toks = this.pretokens(text).map(([t, s]) => (s ? SP : "") + t);
    } else if (this.name === "bpe") {
      toks = this.pretokens(text).flatMap(([t, s]) =>
        PLACEHOLDER.test(t) ? [(s ? SP : "") + t] : this.bpe((s ? [SP] : []).concat([...t])));
    } else {
      toks = [...text.replace(/<[a-z]{2,8}>/g, (p) => this.placeholders[p] ?? "")];
    }
    return toks.map((t) => this.ids.get(t) ?? -1);
  }

  bpe(syms) {
    while (syms.length > 1) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < syms.length - 1; i++) {
        const r = this.ranks.get(syms[i] + "\u0000" + syms[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
      }
      if (best < 0) break;
      const a = syms[best], b = syms[best + 1], out = [];
      for (let i = 0; i < syms.length; i++) {
        if (i + 1 < syms.length && syms[i] === a && syms[i + 1] === b) { out.push(a + b); i++; }
        else out.push(syms[i]);
      }
      syms = out;
    }
    return syms;
  }

  // Display pieces for one token: { space, text, redacted }
  piece(id) {
    if (id < 0) return { space: false, text: "?", redacted: null };
    let t = this.vocab[id];
    if (id === EOS || id === BOS) return { space: false, text: "", redacted: null };
    if (this.name === "char") {
      const p = this.placeholderOf.get(t);
      return p ? { space: false, text: "", redacted: p.slice(1, -1) } : { space: false, text: t, redacted: null };
    }
    const space = t.startsWith(SP);
    if (space) t = t.slice(1);
    const m = t.match(/^<([a-z]{2,8})>$/);
    return m ? { space, text: "", redacted: m[1] } : { space, text: t.replaceAll(SP, " "), redacted: null };
  }

  detok(ids) {
    return ids.map((id) => {
      const p = this.piece(id);
      return (p.space ? " " : "") + (p.redacted ? `<${p.redacted}>` : p.text);
    }).join("").trim();
  }

  // ---- Kneser-Ney ----

  // Returns { p, levels } where p is the interpolated distribution over the
  // vocabulary and levels records each order's backoff weight and counts,
  // so explain() can decompose any token's probability afterwards.
  distribution(ctx, K) {
    let p = new Float64Array(this.V).fill(1 / this.V);
    const levels = [];
    for (let k = 1; k <= K; k++) {
      const key = k === 1 ? "" : ctx.slice(ctx.length - (k - 1)).join(",");
      const e = k === 1 || ctx.length >= k - 1 ? this.tables[k].get(key) : undefined;
      if (!e) { levels.push({ k, found: false }); continue; }
      const top = k === K;
      const counts = top ? e.raw : e.cont, total = top ? e.rawSum : e.contSum;
      const D = (top ? this.discount.raw : this.discount.cont)[k];
      let types = 0;
      for (let i = 0; i < counts.length; i++) if (counts[i] > 0) types++;
      if (total <= 0) { levels.push({ k, found: false }); continue; }
      const gamma = (D * types) / total;
      for (let w = 0; w < this.V; w++) p[w] *= gamma;
      for (let i = 0; i < counts.length; i++) p[e.w[i]] += Math.max(counts[i] - D, 0) / total;
      levels.push({ k, found: true, gamma, total, D, e, top });
    }
    return { p, levels };
  }

  // Per-order contributions to p(w): [{ k, share, count }] (shares sum to p(w)).
  explain(levels, w) {
    let contrib = [{ k: 0, share: 1 / this.V, count: 0 }];
    for (const L of levels) {
      if (!L.found) continue;
      contrib = contrib.map((c) => ({ ...c, share: c.share * L.gamma }));
      const i = L.e.w.indexOf(w);
      const count = i < 0 ? 0 : (L.top ? L.e.raw : L.e.cont)[i];
      contrib.push({ k: L.k, share: Math.max(count - L.D, 0) / L.total, count, raw: i < 0 ? 0 : L.e.raw[i] });
    }
    return contrib;
  }

  // Highest order whose context was seen AND that saw w right after it.
  matchedOrder(levels, w) {
    let best = 0;
    for (const L of levels) if (L.found && L.e.w.indexOf(w) >= 0) best = L.k;
    return best;
  }

  // ---- novelty guard ----

  completedWords(text) {
    const words = text.toLowerCase().split(/\s+/);
    if (!/\s$/.test(text)) words.pop(); // last word may still be growing
    return words.map((w) => w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "")).filter(Boolean);
  }

  quotes(words) {
    const W = this.novelty?.window;
    if (!W || words.length < W) return false;
    return this.novelty.has(fnv1a(words.slice(-W).join(" ")));
  }

  // ---- generation ----

  *generate(promptText = "", opts = {}, rng = Math.random) {
    const o = { ...DEFAULTS, ...PER_MODEL[this.name], ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null)) };
    const K = Math.min(o.order ?? this.order, this.order);
    const prompt = promptText.trim() ? this.encode(promptText) : [];
    const pad = new Array(this.order - 1).fill(BOS);
    const out = []; // { id, matched, levels, p, candidates }
    const bans = new Map(); // position -> Set of banned ids (novelty backtracking)
    let backtracks = 0, lastWordCount = 0, lowStreak = 0;

    yield { type: "prompt", ids: prompt };

    while (out.length < o.maxTokens) {
      const ctx = pad.concat(prompt, out.map((t) => t.id));
      const { p, levels } = this.distribution(ctx, K);
      const q = Float64Array.from(p);
      q[BOS] = 0;
      if (out.length < o.minTokens) q[EOS] = 0;
      // Letters: don't stop mid-word.
      if (this.name === "char" && out.length && /[\p{L}\p{N}]/u.test(this.vocab[out.at(-1).id] ?? "")) q[EOS] = 0;
      if (o.spice > 0) for (let w = 2; w < this.V; w++) q[w] *= Math.pow(this.unigram[w], -o.spice);
      if (o.repetition > 1) {
        for (const t of out.slice(-o.repWindow)) if (t.id > EOS) q[t.id] /= o.repetition;
      }
      const seq = prompt.concat(out.map((t) => t.id));
      if (o.noRepeat > 1 && seq.length >= o.noRepeat - 1) {
        const n = o.noRepeat, tail = seq.slice(seq.length - (n - 1)).join(",");
        for (let i = 0; i + n - 1 < seq.length; i++) {
          if (seq.slice(i, i + n - 1).join(",") === tail) q[seq[i + n - 1]] = 0;
        }
      }
      for (const b of bans.get(out.length) ?? []) q[b] = 0;
      const id = sample(q, o.temperature, o.minP, rng);
      if (id < 0) break;

      const matched = this.matchedOrder(levels, id);
      const step = { id, matched, levels, p, q, ctx };
      out.push(step);

      if (o.novelty && this.novelty && backtracks < 40) {
        const words = this.completedWords(this.detok(prompt.concat(out.map((t) => t.id))) + (id === EOS ? " " : ""));
        if (words.length > lastWordCount && this.quotes(words)) {
          // Back up to where the offending word began and ban that token there.
          const back = this.wordStart(prompt, out);
          const pos = Math.max(back, 0);
          const banned = out[pos].id;
          out.length = pos;
          if (!bans.has(pos)) bans.set(pos, new Set());
          bans.get(pos).add(banned);
          backtracks++;
          yield { type: "rewind", to: pos };
          lastWordCount = this.completedWords(this.detok(prompt.concat(out.map((t) => t.id)))).length;
          continue;
        }
        lastWordCount = words.length;
      }

      yield { type: "token", index: out.length - 1, ...step };
      if (id === EOS) break;
      lowStreak = matched <= 1 ? lowStreak + 1 : 0;
      if (o.stall && lowStreak >= o.stall) { yield { type: "stalled" }; break; }
    }
    yield { type: "done", ids: prompt.concat(out.map((t) => t.id)) };
  }

  // Index in `out` of the first token of the most recently completed word.
  wordStart(prompt, out) {
    let i = out.length - 1;
    const startsWord = (id) => {
      const t = this.vocab[id] ?? "";
      return this.name === "char" ? t === " " : t.startsWith(SP) || id === EOS;
    };
    // Skip the token that closed the word (the new word's start / the space).
    if (i > 0 && startsWord(out[i].id)) i--;
    while (i > 0 && !startsWord(out[i].id)) i--;
    if (this.name === "char" && out[i] && out[i].id >= 0 && this.vocab[out[i].id] === " " && i + 1 < out.length) i++;
    return i;
  }
}

function sample(q, temperature, minP, rng) {
  const inv = 1 / Math.max(temperature, 0.05);
  let max = 0;
  for (let i = 0; i < q.length; i++) if (q[i] > max) max = q[i];
  if (max <= 0) return -1;
  let total = 0;
  const r = new Float64Array(q.length);
  for (let i = 0; i < q.length; i++) {
    if (q[i] <= 0 || q[i] < minP * max) continue;
    r[i] = Math.pow(q[i] / max, inv);
    total += r[i];
  }
  let x = rng() * total;
  for (let i = 0; i < r.length; i++) {
    x -= r[i];
    if (x <= 0 && r[i] > 0) return i;
  }
  return r.findLastIndex((v) => v > 0);
}

export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

export function loadNovelty(data) {
  const bin = typeof atob === "function" ? atob(data.hashes) : Buffer.from(data.hashes, "base64").toString("binary");
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const hashes = new Uint32Array(bytes.buffer);
  return {
    window: data.window,
    has(h) {
      let lo = 0, hi = hashes.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (hashes[mid] === h) return true;
        if (hashes[mid] < h) lo = mid + 1; else hi = mid - 1;
      }
      return false;
    },
  };
}
