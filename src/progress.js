/**
 * Progreso de lectura, marcas leído/no leído y recientes.
 */
import * as sync from './sync.js';

const pageKey = (chId, msgId) => `page:${chId}:${msgId}`;
const pagesKey = (chId, msgId) => `pages:${chId}:${msgId}`;
const legacyPageKey = (msgId) => 'page:' + msgId;
const legacyPagesKey = (msgId) => 'pages:' + msgId;
const pageFmtKey = (chId, msgId) => `pagefmt:${chId}:${msgId}`;
const readFlagKey = (chId, msgId) => `read:${chId}:${msgId}`;
const lastReadKey = 'lastRead';
const recentKey = 'recentReads';

export function getPageIndex(chId, msgId) {
  const k = pageKey(chId, msgId);
  let v = localStorage.getItem(k);
  if (v == null) {
    v = localStorage.getItem(legacyPageKey(msgId));
    if (v != null) {
      try { localStorage.setItem(k, v); } catch (_) {}
    }
  }
  return Math.max(0, +(v || 0) || 0);
}

export function setPageIndex(chId, msgId, n) {
  try {
    localStorage.setItem(pageKey(chId, msgId), String(n));
    localStorage.removeItem(legacyPageKey(msgId));
  } catch (_) {}
  try { sync.schedulePush(); } catch (_) {}
}

export function getPagesTotal(chId, msgId) {
  const k = pagesKey(chId, msgId);
  let v = localStorage.getItem(k);
  if (v == null) {
    v = localStorage.getItem(legacyPagesKey(msgId));
    if (v != null) {
      try { localStorage.setItem(k, v); } catch (_) {}
    }
  }
  return Math.max(0, +(v || 0) || 0);
}

export function setPagesTotal(chId, msgId, tot) {
  try {
    localStorage.setItem(pagesKey(chId, msgId), String(tot));
    localStorage.removeItem(legacyPagesKey(msgId));
  } catch (_) {}
}

export function getPageFormat(chId, msgId) {
  try { return localStorage.getItem(pageFmtKey(chId, msgId)) || ''; } catch { return ''; }
}

export function setPageFormat(chId, msgId, fmt) {
  try { if (fmt) localStorage.setItem(pageFmtKey(chId, msgId), fmt); } catch (_) {}
}

export function detectPageFormats(pages) {
  const set = new Set();
  for (const p of pages || []) {
    const n = String(p.filename || p.name || '').toLowerCase();
    if (/\.jpe?g$/.test(n)) set.add('JPEG');
    else if (/\.png$/.test(n)) set.add('PNG');
    else if (/\.webp$/.test(n)) set.add('WebP');
    else if (/\.gif$/.test(n)) set.add('GIF');
    else if (/\.avif$/.test(n)) set.add('AVIF');
    else if (p.blob?.type) {
      const tp = p.blob.type;
      if (tp.includes('jpeg')) set.add('JPEG');
      else if (tp.includes('png')) set.add('PNG');
      else if (tp.includes('webp')) set.add('WebP');
      else if (tp.includes('gif')) set.add('GIF');
    }
  }
  return [...set].join(' / ');
}

export function isComicRead(chId, msgId) {
  try {
    if (localStorage.getItem(readFlagKey(chId, msgId)) === '1') return true;
  } catch (_) {}
  const prog = readProgress(chId, msgId);
  return !!(prog && prog.pct >= 95);
}

export function readProgress(chId, msgId) {
  const marked = (() => { try { return localStorage.getItem(readFlagKey(chId, msgId)) === '1'; } catch { return false; } })();
  const cur = getPageIndex(chId, msgId);
  const tot = getPagesTotal(chId, msgId);
  if (marked) {
    const t = tot > 0 ? tot : 1;
    return { cur: t, tot: t, pct: 100 };
  }
  if (!tot || tot < 1) return null;
  if (cur <= 0) return null;
  return { cur: cur + 1, tot, pct: Math.min(100, Math.round(((cur + 1) / tot) * 100)) };
}

export function markComicRead(ch, f, after) {
  try { localStorage.setItem(readFlagKey(ch.id, f.id), '1'); } catch (_) {}
  const tot = getPagesTotal(ch.id, f.id);
  if (tot > 0) {
    try { localStorage.setItem(pageKey(ch.id, f.id), String(Math.max(0, tot - 1))); } catch (_) {}
  }
  try {
    const list = getRecentReads().filter((x) => !(x.ch?.id === ch.id && x.f?.id === f.id));
    localStorage.setItem(recentKey, JSON.stringify(list.slice(0, 5)));
  } catch (_) {}
  try { sync.schedulePush(); } catch (_) {}
  after?.();
}

export function markComicUnread(ch, f, after) {
  try { localStorage.removeItem(readFlagKey(ch.id, f.id)); } catch (_) {}
  try { localStorage.setItem(pageKey(ch.id, f.id), '0'); } catch (_) {}
  try { sync.schedulePush(); } catch (_) {}
  after?.();
}

export function markSeriesRead(ch, files, after) {
  for (const f of files || []) markComicRead(ch, f);
  after?.();
}

export function markSeriesUnread(ch, files, after) {
  for (const f of files || []) markComicUnread(ch, f);
  after?.();
}

export function getLastRead() {
  try { return JSON.parse(localStorage.getItem(lastReadKey) || 'null'); } catch { return null; }
}

export function getRecentReads() {
  try {
    const raw = JSON.parse(localStorage.getItem(recentKey) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function getContinueList() {
  const list = getRecentReads().filter((x) => x?.ch?.id && x?.f?.id && !isComicRead(x.ch.id, x.f.id));
  const last = getLastRead();
  if (last?.ch?.id && last?.f?.id && !isComicRead(last.ch.id, last.f.id)) {
    if (!list.some((x) => x.ch.id === last.ch.id && x.f.id === last.f.id)) list.unshift(last);
  }
  return list.slice(0, 5);
}

export function setLastRead(ch, f) {
  const entry = {
    ch: { id: ch.id, hash: ch.hash, name: ch.name, group: ch.group },
    f: { id: f.id, name: f.name, size: f.size },
    at: Date.now(),
  };
  try {
    localStorage.setItem(lastReadKey, JSON.stringify(entry));
    let list = getRecentReads().filter((x) => !(x.ch?.id === ch.id && x.f?.id === f.id));
    list.unshift(entry);
    localStorage.setItem(recentKey, JSON.stringify(list.slice(0, 12)));
  } catch (_) {}
  try { sync.schedulePush(); } catch (_) {}
}
