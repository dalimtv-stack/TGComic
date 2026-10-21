/**
 * Títulos de tarjetas con "balanced wrapping": hasta 2 líneas con anchuras lo más parecidas posible.
 * - Los textos entre paréntesis/corchetes forman un bloque que no se parte, p. ej. "(1 de 5)".
 * - Separadores sueltos ("-", ":", "&"…) se quedan al final de la línea anterior, nunca al principio.
 * - Palabras de 1-2 letras ("de", "la", "y"…) se pegan a la siguiente: no quedan colgando al final de línea.
 * - El texto sigue centrado (lo hace el CSS); aquí solo se decide dónde cortar.
 */
const ctx = document.createElement('canvas').getContext('2d');
const SEP_ONLY = /^[-–—:&/·|+]+$/;
// Márgenes para que la decisión sea la misma en todos los dispositivos aunque cambie la tipografía del sistema
const ONE_LINE_FIT = 0.98;  // una línea solo si ocupa ≤ 90 % del ancho
const LINE_FIT = 0.99;     // cada línea de un corte ≤ 98 % del ancho
const isShortWord = (w) => /^\p{L}{1,2}$/u.test(w);

export function tokenize(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const opens = (w) => { const i = w.search(/[(\[]/); return i >= 0 && !/[)\]]/.test(w.slice(i)); };
  const blocks = [];
  let acc = null;
  for (const w of words) {
    if (acc !== null) {
      acc += ' ' + w;
      if (/[)\]][^)\]]*$/.test(w)) { blocks.push(acc); acc = null; }
      continue;
    }
    if (opens(w)) { acc = w; continue; }
    blocks.push(w);
  }
  if (acc !== null) blocks.push(acc);

  const withSeps = [];
  for (const b of blocks) {
    if (SEP_ONLY.test(b) && withSeps.length) withSeps[withSeps.length - 1] += ' ' + b;
    else withSeps.push(b);
  }
  const out = [];
  for (let i = 0; i < withSeps.length; i++) {
    let cur = withSeps[i];
    while (i < withSeps.length - 1 && isShortWord(cur.split(' ').pop())) cur += ' ' + withSeps[++i];
    out.push(cur);
  }
  return out;
}

/** Devuelve [texto] si cabe en una línea, [a, b] equilibradas, o null si no hay corte válido. */
export function layout(tokens, avail, measure) {
  const full = tokens.join(' ');
  if (measure(full) <= avail * ONE_LINE_FIT) return [full];
  let best = null;
  for (let k = 1; k < tokens.length; k++) {
    const a = tokens.slice(0, k).join(' '), b = tokens.slice(k).join(' ');
    const wa = measure(a), wb = measure(b);
    if (wa > avail * LINE_FIT || wb > avail * LINE_FIT) continue;
    const diff = Math.abs(wa - wb);
    if (!best || diff < best.diff) best = { a, b, diff };
  }
  if (best) return [best.a, best.b];
  return measure(full) <= avail ? [full] : null;
}

export function balanceTitles(root = document) {
  for (const b of root.querySelectorAll('.card .name b')) {
    const nm = b.parentElement;
    if (!nm) continue;
    const pcs = getComputedStyle(nm);
    const avail = nm.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0) - 1;
    if (!(avail > 20)) continue;
    // Texto original (si alguien lo cambia por fuera, se vuelve a tomar)
    let full = b.dataset.full;
    if (full === undefined || (b.textContent !== b.dataset.applied && b.textContent !== full)) {
      full = b.textContent;
      b.dataset.full = full;
    }
    const cs = getComputedStyle(b);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const lines = layout(tokenize(full), avail, (t) => ctx.measureText(t).width);
    const two = !!lines && lines.length === 2;
    const next = two ? lines.join('\n') : full;
    if (b.textContent !== next) b.textContent = next;
    b.dataset.applied = next;
    b.style.whiteSpace = two ? 'pre-line' : '';
  }
}

export function initBalance(app) {
  if (!app || app.__balance) return;
  app.__balance = true;
  let raf = 0, running = false;
  const run = () => {
    raf = 0; running = true;
    try { balanceTitles(app); } catch (e) { console.warn('balance', e); } finally { running = false; mo.takeRecords(); }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
  const mo = new MutationObserver(() => { if (!running) schedule(); });
  mo.observe(app, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('covers-resized', schedule);
  try { document.fonts?.ready?.then(schedule); } catch (_) {}
  try { new ResizeObserver(schedule).observe(app); } catch (_) {}
  schedule();
}
