/**
 * Versiones de calidad de un mismo cómic (mismo nombre, distinta etiqueta final):
 *   Batman #01.cbz                  → alta  (high)
 *   Batman #01 [WebP].cbz           → media (mid)
 *   Batman #01 [2400px][WebP].cbz   → baja  (low)
 * En el listado solo se muestra una entrada (la de mayor calidad disponible) con `variants`.
 */
export const QUALITIES = ['high', 'mid', 'low'];
export const QUALITY_LABEL = { high: 'Alta', mid: 'Media', low: 'Baja' };
// Orden de preferencia cuando la calidad pedida no existe para ese cómic
const FALLBACK = {
  high: ['high', 'mid', 'low'],
  mid: ['mid', 'high', 'low'],
  low: ['low', 'mid', 'high'],
};
const TAGS_END = /(?:\s*\[(?:\d{3,5}\s*px|webp)\])+\s*$/i;

export function parseQuality(name) {
  const stem = String(name || '').replace(/\.[^.\\/]+$/, '');
  const m = stem.match(TAGS_END);
  const tags = m ? m[0].toLowerCase() : '';
  const base = (m ? stem.slice(0, m.index) : stem).replace(/\s+/g, ' ').trim();
  const q = /px\]/.test(tags) ? 'low' : (/\[webp\]/.test(tags) ? 'mid' : 'high');
  return { base, key: base.toLowerCase(), q };
}

/** Elige la versión a abrir: la pedida, o la más cercana disponible. */
export function resolveQuality(f, want) {
  const v = f?.variants;
  if (!v) return null;
  for (const q of FALLBACK[want] || FALLBACK.high) if (v[q]) return q;
  return null;
}

/** Devuelve el archivo concreto (id/size/name…) de la calidad `q`, o el propio f si no hay variantes. */
export function pickVariant(f, q) {
  const v = f?.variants?.[q];
  return v ? { ...f, ...v, id: v.id } : f;
}

/** Aplana una lista (con o sin variants) a todos los archivos reales. */
export function flattenVersions(list) {
  const out = [];
  for (const f of list || []) {
    if (f?.variants && typeof f.variants === 'object') {
      for (const q of QUALITIES) { const v = f.variants[q]; if (v) out.push({ ...v }); }
    } else if (f) out.push(f);
  }
  return out;
}

/** Agrupa versiones: una entrada por cómic (la de mayor calidad) con `variants`. Conserva el orden. */
export function collapseVersions(files) {
  const groups = new Map();
  const order = [];
  const extra = []; // duplicados exactos de calidad (no se ocultan)
  for (const f of files || []) {
    const { key, q } = parseQuality(f.name);
    let g = groups.get(key);
    if (!g) { g = { pos: order.length, slots: {} }; groups.set(key, g); order.push(g); }
    if (g.slots[q]) { extra.push({ pos: g.pos, f }); continue; }
    g.slots[q] = f;
  }
  const out = [];
  order.forEach((g, i) => {
    const have = QUALITIES.filter((q) => g.slots[q]);
    const rep = g.slots[have[0]];
    if (have.length < 2) { out.push(rep); }
    else {
      const variants = {};
      for (const q of have) {
        const { id, name, size, caption } = g.slots[q];
        variants[q] = { id, name, size, ...(caption ? { caption } : {}) };
      }
      out.push({ ...rep, variants });
    }
    for (const e of extra) if (e.pos === i) out.push(e.f);
  });
  return out;
}
