import { parseComicCaption, parseComicName, comicDisplay, issueDisplay } from './parse.js';
/**
 * Metadatos locales: renombres de serie/cómic, serie asignada a un cómic,
 * desagrupar, nombres de canal/editorial.
 */
import * as sync from './sync.js';

const ugKey = (ch) => 'ungroup:' + ch.id;
const snKey = (ch) => 'seriesName:' + ch.id;
const comicNameKey = (ch) => 'comicName:' + ch.id;
const comicSeriesKey = (ch) => 'comicSeries:' + ch.id;
const cnKey = 'channelNames';
const gnKey = 'groupNames';

function readMap(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function writeMap(key, m) {
  try { localStorage.setItem(key, JSON.stringify(m)); } catch (_) {}
  try { sync.schedulePush(); } catch (_) {}
}

// ----- Desagrupar -----
export function ungroupMap(ch) {
  try {
    const raw = JSON.parse(localStorage.getItem(ugKey(ch)) || '{}');
    if (Array.isArray(raw)) {
      const m = {};
      for (const k of raw) m[String(k).toLowerCase()] = 'full';
      return m;
    }
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
export function setUngroupMode(ch, label, mode, after) {
  const m = ungroupMap(ch);
  const k = String(label || '').toLowerCase();
  if (!k) return after?.();
  if (!mode) delete m[k];
  else m[k] = mode;
  writeMap(ugKey(ch), m);
  after?.();
}

// ----- Nombre de serie (display) -----
export function seriesRenameMap(ch) {
  return readMap(snKey(ch));
}
export function seriesDisplayName(ch, originalLabel) {
  const m = seriesRenameMap(ch);
  return m[String(originalLabel || '').toLowerCase()] || originalLabel;
}
export function setSeriesDisplayName(ch, originalLabel, newName, after) {
  const m = seriesRenameMap(ch);
  const k = String(originalLabel || '').toLowerCase();
  const n = String(newName || '').trim();
  if (!k) return after?.();
  if (!n || n.toLowerCase() === k) delete m[k];
  else m[k] = n;
  writeMap(snKey(ch), m);
  after?.();
}

// ----- Título de cómic -----
export function comicRenameMap(ch) {
  return readMap(comicNameKey(ch));
}
export function comicDisplayName(ch, f, fallback) {
  if (!ch || !f) return fallback || '';
  const m = comicRenameMap(ch);
  const custom = m[String(f.id)];
  let t = '';
  if (custom != null && String(custom).trim()) {
    t = String(custom).trim();
  } else {
    const fb = String(fallback || '').trim();
    // Vista serie / listado de números: fallback "#…" → solo número/info
    const inSeriesView = /^#/.test(fb);
    try {
      const cap = parseComicCaption(f.caption || '');
      const titleEs = cap.titleEs && String(cap.titleEs).trim();
      if (titleEs) {
        const asName = /\.cb[zr]$/i.test(titleEs) ? titleEs : (titleEs + '.cbz');
        const pCap = parseComicName(asName, ch.name);
        if (inSeriesView) {
          // Nunca devolver "Serie #n" aquí
          if (pCap) t = issueDisplay(pCap);
          else {
            const mHash = titleEs.match(/#\s*(.+)$/);
            t = mHash ? ('#' + mHash[1].replace(/^#\s*/, '').trim()) : fb;
          }
        } else if (pCap) {
          t = comicDisplay(asName, ch.name) || issueDisplay(pCap);
        } else {
          t = titleEs;
        }
      }
    } catch (_) {}
    if (!t) t = fb || '';
    // Si aún quedó "Serie #n" y el fallback era "#…", forzar solo el hash
    if (inSeriesView && t && !/^#/.test(t)) {
      const mHash = t.match(/#\s*(.+)$/);
      if (mHash) t = '#' + mHash[1].replace(/^#\s*/, '').trim();
      else t = fb;
    }
  }
  const chName = String(ch.name || '').trim();
  if (t && chName) {
    try {
      const esc = chName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = t.replace(new RegExp('^' + esc + '\\s*-\\s*', 'i'), '').trim();
      if (stripped) t = stripped;
    } catch (_) {}
  }
  return t;
}
export function setComicDisplayName(ch, f, newName, after) {
  if (!ch || !f?.id) return after?.();
  const m = comicRenameMap(ch);
  const k = String(f.id);
  const n = String(newName || '').trim();
  if (!n) delete m[k];
  else m[k] = n;
  writeMap(comicNameKey(ch), m);
  after?.();
}

// ----- Serie asignada a un cómic (agrupación) -----
export function comicSeriesMap(ch) {
  return readMap(comicSeriesKey(ch));
}
/** Serie efectiva: override manual o null si se usa el parseo del nombre */
export function getComicSeriesOverride(ch, f) {
  if (!ch || !f?.id) return null;
  const v = comicSeriesMap(ch)[String(f.id)];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
/**
 * Asigna serie. newSeries vacío = quitar override (vuelve al parseo del archivo).
 * Si la serie existe (mismo nombre, case-insensitive) se agrupa con ella.
 */
export function setComicSeries(ch, f, newSeries, after) {
  if (!ch || !f?.id) return after?.();
  const m = comicSeriesMap(ch);
  const k = String(f.id);
  const n = String(newSeries || '').trim();
  if (!n) delete m[k];
  else m[k] = n;
  writeMap(comicSeriesKey(ch), m);
  after?.();
}

/** Callback para groupSeries: fuerza serie por cómic si hay override */
export function seriesOverrideFor(ch) {
  const m = comicSeriesMap(ch);
  return (f) => {
    const v = m[String(f?.id)];
    return v != null && String(v).trim() ? String(v).trim() : null;
  };
}

// ----- Canal / editorial -----
export function channelRenameMap() {
  return readMap(cnKey);
}
export function channelDisplayName(ch) {
  if (!ch) return '—';
  const m = channelRenameMap();
  return m[String(ch.id)] || ch.name || '—';
}
export function setChannelDisplayName(ch, newName, after) {
  if (!ch?.id) return after?.();
  const m = channelRenameMap();
  const n = String(newName || '').trim();
  if (!n || n === ch.name) delete m[String(ch.id)];
  else m[String(ch.id)] = n;
  writeMap(cnKey, m);
  after?.();
}

export function groupRenameMap() {
  return readMap(gnKey);
}
export function groupDisplayName(name) {
  const n = String(name || '');
  const m = groupRenameMap();
  return m[n.toLowerCase()] || n || '—';
}
export function setGroupDisplayName(originalName, newName, after) {
  const m = groupRenameMap();
  const k = String(originalName || '').toLowerCase();
  const n = String(newName || '').trim();
  if (!k) return after?.();
  if (!n || n.toLowerCase() === k || n === originalName) delete m[k];
  else m[k] = n;
  writeMap(gnKey, m);
  after?.();
}
