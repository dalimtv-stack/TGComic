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
// Etiquetas finales: [2400px], [WebP] y el factor de calidad [0.40] (p. ej. "… [0.40][WebP]", "… [2400px][WebP]")
const TAG = '\\[(?:\\d{3,5}\\s*px|webp|[01]?[.,]\\d{1,2})\\]';
const TAGS_END = new RegExp('(?:\\s*' + TAG + ')+\\s*$', 'i');
// Nombre de documento "saneado" por Telegram (sin corchetes): …_USA_0_40WebP / …_USA_2400pxWebP
const SANITIZED_END = /(?:_\d{1,2}_\d{1,2})?(?:_?\d{3,5}px)?_?webp\s*$/i;

/** "Nombre de archivo: X" del caption de Telegram (el nombre real; el del documento puede venir recortado con "_"). */
export function captionFileName(caption) {
  const m = String(caption || '').match(/^\s*Nombre de archivo\s*:\s*(.+?)\s*$/im);
  return m ? m[1].trim() : '';
}
/** Nombre de origen de una entrada: caption primero, si no el nombre del documento. */
export function sourceNameOf(f) {
  return captionFileName(f?.caption) || String(f?.name || '');
}

const stemOf = (name) => String(name || '').replace(/\.(cb[zr]|zip|rar|7z|cb7)+$/i, '');

/** Quita las etiquetas de calidad finales ([0.40] [2400px] [WebP]) de un nombre (con o sin extensión). */
export function stripQualityTags(name) {
  const s = stemOf(String(name || '').replace(/_/g, ' ')).trim();
  const m = s.match(TAGS_END);
  return (m && /webp|px/i.test(m[0]) ? s.slice(0, m.index) : s).replace(/\s+/g, ' ').trim();
}

// Versiones mejoradas con IA: "… [Mejora-IA][ESRGAN].cbz" (el modelo es opcional)
const AI_END = /\s*\[\s*mejora[\s_-]*ia\s*\]((?:\s*\[[^\]]*\])*)\s*$/i;
// Nombre saneado por Telegram (sin corchetes): …_Mejora-IA_ESRGAN_
const AI_SANITIZED = /[\s_]*mejora[\s_-]*ia[\s_]*(.*)$/i;

/** Detecta la etiqueta [Mejora-IA] y separa el modelo. Devuelve { rest, model } o null. */
export function parseAiTag(name) {
  const stem = stemOf(String(name || '')).trim();
  let m = stem.match(AI_END);
  if (m) {
    const model = (m[1] || '').replace(/^\s*\[|\]\s*$/g, '').replace(/\]\s*\[/g, ' · ').trim();
    return { rest: stem.slice(0, m.index), model };
  }
  m = stem.match(AI_SANITIZED);
  if (m && /_/.test(stem)) {
    return { rest: stem.slice(0, m.index), model: m[1].replace(/_+/g, ' ').trim() };
  }
  return null;
}

/** Texto para el selector: el modelo, o "Mejora IA" si no lo indica. */
export function aiLabel(name) {
  const t = parseAiTag(name);
  return (t && t.model) || 'Mejora IA';
}

export function parseQuality(name) {
  const ai = parseAiTag(name);
  if (ai) {
    const r = parseQuality(ai.rest);
    return { ...r, ai: true, model: ai.model };
  }
  const raw = String(name || '');
  const hadUnderscores = raw.includes('_') && !/\s/.test(raw.trim());
  const stem = stemOf(raw.replace(/_/g, ' ')).trim();
  let m = stem.match(TAGS_END);
  let tags = m && /webp|px/i.test(m[0]) ? m[0].toLowerCase() : '';
  let base;
  if (tags) base = stem.slice(0, m.index);
  else if (hadUnderscores && SANITIZED_END.test(stemOf(raw))) {
    // Solo nombre de documento de Telegram (sin caption): tags sin corchetes
    const sm = stemOf(raw).match(SANITIZED_END);
    tags = sm[0].toLowerCase();
    base = stemOf(raw).slice(0, sm.index).replace(/_/g, ' ');
  } else base = stem;
  base = base.replace(/\s+/g, ' ').trim();
  const q = /px/.test(tags) ? 'low' : (/webp/.test(tags) ? 'mid' : 'high');
  // Clave: solo letras y números (sin acentos). Comparable entre caption y nombre de documento recortado
  const key = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return { base, key, q };
}

/**
 * Normaliza el nombre de salida al subir/recargar con WebP:
 *   base [2400px][WebP].cbz   (si se redimensiona)  |  base [WebP].cbz
 * Conserva un factor de calidad [0.40] si el nombre ya lo traía.
 */
export function withQualityTags(name, { webp = true, resize = false } = {}) {
  if (!webp) return String(name || '');
  const s0 = stemOf(String(name || '').replace(/_/g, ' ')).trim();
  const mq = s0.match(/\[([01]?[.,]\d{1,2})\]\s*(?:\[[^\]]*\]\s*)*$/);
  const qf = mq && /webp|px/i.test(s0.slice(mq.index)) ? `[${mq[1]}]` : '';
  const base = stripQualityTags(name);
  return `${base} ${qf}${resize ? '[2400px]' : ''}[WebP].cbz`;
}

/** Copia ya existente (misma serie/número y misma calidad) de `outName` en una lista de archivos. */
export function existingCopy(list, outName) {
  const p = parseQuality(outName);
  if (!p.key) return null;
  for (const x of list || []) {
    const px = parseQuality(sourceNameOf(x));
    if (px.key === p.key && px.q === p.q && !px.ai === !p.ai) return x;
  }
  return null;
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
    if (Array.isArray(f?.ai)) for (const v of f.ai) if (v) out.push({ ...v });
  }
  return out;
}

/** Agrupa versiones: una entrada por cómic (la de mayor calidad) con `variants`. Conserva el orden. */
export function collapseVersions(files, nameOf = sourceNameOf) {
  const groups = new Map();
  const order = [];
  const extra = []; // duplicados exactos de calidad (no se ocultan)
  for (const f of files || []) {
    const { key, q, ai } = parseQuality(nameOf(f));
    let g = groups.get(key);
    if (!g) { g = { pos: order.length, slots: {}, ai: [] }; groups.set(key, g); order.push(g); }
    if (ai) { g.ai.push(f); continue; } // versiones [Mejora-IA]: no se listan, se eligen en el visor
    if (g.slots[q]) { extra.push({ pos: g.pos, f }); continue; }
    g.slots[q] = f;
  }
  const out = [];
  order.forEach((g, i) => {
    // Solo hay versiones IA (sin original): la primera hace de entrada principal
    if (!QUALITIES.some((q) => g.slots[q]) && g.ai.length) g.slots.high = g.ai.shift();
    const have = QUALITIES.filter((q) => g.slots[q]);
    let rep = g.slots[have[0]];
    if (g.ai.length) {
      rep = {
        ...rep,
        ai: g.ai.map(({ id, name, size, caption }) => ({ id, name, size, ...(caption ? { caption } : {}) }))
          .sort((a, b) => aiLabel(sourceNameOf(a)).localeCompare(aiLabel(sourceNameOf(b)), undefined, { numeric: true, sensitivity: 'base' })),
      };
    }
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

/**
 * Estadísticas de una lista de archivos separando las copias WebP (Media/Baja) del resto.
 * Aplana las entradas agrupadas (variants) y clasifica cada archivo real por su nombre.
 *   main = archivos sin etiqueta WebP (Alta)   ·   webp = copias [WebP] y [2400px][WebP]
 */
export function splitStats(files) {
  const out = {
    main: { n: 0, bytes: 0 },
    webpMid: { n: 0, bytes: 0 },
    webpLow: { n: 0, bytes: 0 },
    webp: { n: 0, bytes: 0 },
    ai: { n: 0, bytes: 0 },
    total: { n: 0, bytes: 0 },
  };
  for (const f of flattenVersions(files)) {
    const pq = parseQuality(sourceNameOf(f));
    const sz = Number(f?.size) || 0;
    out.total.n++;
    out.total.bytes += sz;
    if (pq.ai) {
      out.ai.n++;
      out.ai.bytes += sz;
    } else if (pq.q === 'high') {
      out.main.n++;
      out.main.bytes += sz;
    } else if (pq.q === 'low') {
      out.webpLow.n++;
      out.webpLow.bytes += sz;
      out.webp.n++;
      out.webp.bytes += sz;
    } else {
      // mid (WebP sin px)
      out.webpMid.n++;
      out.webpMid.bytes += sz;
      out.webp.n++;
      out.webp.bytes += sz;
    }
  }
  return out;
}
