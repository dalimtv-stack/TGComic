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
const ONE_LINE_FIT = 0.998; // una línea si ocupa ≤ 99.8 % del ancho útil (ya se resta 1 px)
const LINE_FIT = 0.998;    // cada línea de un corte ≤ 99.8 % del ancho útil
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

const AUTO_MIN = 8;
const AUTO_KINDS = {
  'cover-comic': ['textAutoComic', 'coverTextComic'],
  'cover-series': ['textAutoSeries', 'coverTextSeries'],
  'cover-channel': ['textAutoChannel', 'coverTextChannel'],
};
const devGet = (k, d) => {
  try { const v = localStorage.getItem('device:' + k); return v == null || v === '' ? d : v; } catch { return d; }
};
/** { max } si la tarjeta tiene activado "Ajustar Automáticamente" para su tipo; si no, null. */
function autoInfo(card) {
  const cv = card?.querySelector('.cover');
  if (!cv) return null;
  for (const [cls, [autoKey, sizeKey]] of Object.entries(AUTO_KINDS)) {
    if (!cv.classList.contains(cls)) continue;
    if (devGet(autoKey, '0') !== '1') return null;
    const max = Math.max(AUTO_MIN, Math.min(32, +devGet(sizeKey, '15') || 15));
    return { max };
  }
  return null;
}
/** Subtexto (info gris): una línea; solo se reduce si no cabe (mínimo 8 px). */
function fitSmall(sm, maxPx) {
  const scs = getComputedStyle(sm);
  const w = sm.clientWidth - (parseFloat(scs.paddingLeft) || 0) - (parseFloat(scs.paddingRight) || 0) - 1;
  const text = sm.textContent || '';
  if (!(w > 20) || !text) { sm.style.removeProperty('font-size'); return; }
  let size = maxPx;
  for (; size > AUTO_MIN; size -= 0.25) {
    ctx.font = `${scs.fontStyle} ${scs.fontWeight} ${size}px ${scs.fontFamily}`;
    try { ctx.letterSpacing = scs.letterSpacing === 'normal' ? '0px' : scs.letterSpacing; } catch (_) {}
    if (ctx.measureText(text).width <= w) break;
  }
  size = Math.max(AUTO_MIN, size);
  if (size >= maxPx) sm.style.removeProperty('font-size');
  else sm.style.setProperty('font-size', size + 'px', 'important');
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
    const fontAt = (st, px, fam, wt) => `${st} ${wt} ${px}px ${fam}`;
    const measure = (t) => ctx.measureText(t).width;
    const tokens = tokenize(full);
    // Ajuste automático (por tipo de tarjeta): tamaño entre 8 px y el configurado
    const auto = autoInfo(b.closest('.card'));
    let lines;
    if (auto) {
      let size = auto.max;
      lines = null;
      for (; size >= AUTO_MIN; size -= 0.25) {
        ctx.font = fontAt(cs.fontStyle, size, cs.fontFamily, cs.fontWeight);
        try { ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing; } catch (_) {}
        lines = layout(tokens, avail, measure);
        if (lines) break;
      }
      if (!lines) size = AUTO_MIN;
      if (size >= auto.max) b.style.removeProperty('font-size');
      else b.style.setProperty('font-size', size + 'px', 'important');
      // Subtexto gris: se ajusta por separado, una sola línea
      const sm = nm.parentElement?.querySelector('small');
      if (sm) fitSmall(sm, auto.max * 0.88);
    } else {
      b.style.removeProperty('font-size');
      const sm = nm.parentElement?.querySelector('small');
      if (sm) sm.style.removeProperty('font-size');
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      lines = layout(tokens, avail, measure);
    }
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
