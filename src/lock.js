/**
 * Bloqueo de contenido (+18 / privado).
 * - Marcas en localStorage `contentLocks` (sincronizado).
 * - Sesión siempre empieza bloqueada al abrir la app.
 * - Contraseña = la de sincronización (si no hay login sync, no se puede desbloquear).
 */
import * as sync from './sync.js';
import { parseComicName, seriesBase } from './parse.js';
import { getComicSeriesOverride } from './meta.js';

const LS_LOCKS = 'contentLocks';

/** false al cargar la página; no se persiste el desbloqueo */
let sessionUnlocked = false;

function readLocks() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_LOCKS) || '{}') || {};
    return {
      groups: Array.isArray(o.groups) ? o.groups.map(String) : [],
      channels: Array.isArray(o.channels) ? o.channels.map(String) : [],
      series: Array.isArray(o.series) ? o.series.map(String) : [],
      comics: Array.isArray(o.comics) ? o.comics.map(String) : [],
    };
  } catch (_) {
    return { groups: [], channels: [], series: [], comics: [] };
  }
}

function writeLocks(o) {
  localStorage.setItem(LS_LOCKS, JSON.stringify({
    groups: [...new Set(o.groups || [])],
    channels: [...new Set(o.channels || [])],
    series: [...new Set(o.series || [])],
    comics: [...new Set(o.comics || [])],
  }));
  try { sync.schedulePush(); } catch (_) {}
}

export function canUseLocks() {
  return typeof sync.isLoggedIn === 'function' && sync.isLoggedIn();
}

export function isSessionUnlocked() {
  return sessionUnlocked;
}

export function lockSession() {
  sessionUnlocked = false;
}

/**
 * Desbloquea la sesión comprobando la contraseña de sync.
 * @returns {Promise<boolean>}
 */
export async function unlockSession(password) {
  if (!canUseLocks()) return false;
  const stored = localStorage.getItem('sync:password') || '';
  if (!password || password !== stored) return false;
  sessionUnlocked = true;
  return true;
}

export function seriesLockKey(chId, seriesLabel) {
  return String(chId) + '::' + String(seriesLabel || '').trim().toLowerCase();
}

export function comicLockKey(chId, fileId) {
  return String(chId) + '::' + String(fileId);
}

export function isGroupMarked(groupName) {
  const g = String(groupName || '');
  return readLocks().groups.some((x) => x === g || x.toLowerCase() === g.toLowerCase());
}

export function isChannelMarked(ch) {
  if (!ch?.id) return false;
  return readLocks().channels.includes(String(ch.id));
}

export function isSeriesMarked(ch, seriesLabel) {
  if (!ch?.id) return false;
  const k = seriesLockKey(ch.id, seriesLabel);
  return readLocks().series.includes(k);
}

export function isComicMarked(ch, f) {
  if (!ch?.id || !f?.id) return false;
  return readLocks().comics.includes(comicLockKey(ch.id, f.id));
}

export function setGroupLocked(groupName, locked) {
  const o = readLocks();
  const g = String(groupName || '');
  o.groups = o.groups.filter((x) => x !== g && x.toLowerCase() !== g.toLowerCase());
  if (locked) o.groups.push(g);
  writeLocks(o);
}

export function setChannelLocked(ch, locked) {
  if (!ch?.id) return;
  const o = readLocks();
  const id = String(ch.id);
  o.channels = o.channels.filter((x) => x !== id);
  if (locked) o.channels.push(id);
  writeLocks(o);
}

export function setSeriesLocked(ch, seriesLabel, locked) {
  if (!ch?.id) return;
  const o = readLocks();
  const k = seriesLockKey(ch.id, seriesLabel);
  o.series = o.series.filter((x) => x !== k);
  if (locked) o.series.push(k);
  writeLocks(o);
}

export function setComicLocked(ch, f, locked) {
  if (!ch?.id || !f?.id) return;
  const o = readLocks();
  const k = comicLockKey(ch.id, f.id);
  o.comics = o.comics.filter((x) => x !== k);
  if (locked) o.comics.push(k);
  writeLocks(o);
}

function seriesOfComic(ch, f) {
  try {
    const ov = getComicSeriesOverride(ch, f);
    if (ov) return ov;
    const p = parseComicName(f?.name || '', ch?.name);
    return p?.series || seriesBase(f?.name || '', ch?.name) || '';
  } catch (_) {
    return '';
  }
}

/**
 * ¿Hay que ocultar/impedir acceso? (sesión bloqueada + marca en la jerarquía)
 */
export function isContentRestricted(kind, ref) {
  if (sessionUnlocked) return false;
  if (kind === 'group') return isGroupMarked(ref);
  if (kind === 'channel') {
    const ch = ref;
    return isChannelMarked(ch) || isGroupMarked(ch?.group);
  }
  if (kind === 'series') {
    const { ch, seriesLabel } = ref;
    return isSeriesMarked(ch, seriesLabel)
      || isChannelMarked(ch)
      || isGroupMarked(ch?.group);
  }
  if (kind === 'comic') {
    const { ch, f } = ref;
    const ser = seriesOfComic(ch, f);
    return isComicMarked(ch, f)
      || (ser && isSeriesMarked(ch, ser))
      || isChannelMarked(ch)
      || isGroupMarked(ch?.group);
  }
  return false;
}

export function guardRestricted(kind, ref, label) {
  if (!isContentRestricted(kind, ref)) return true;
  alert(
    (label ? ('«' + label + '» está bloqueado. ') : 'Contenido bloqueado. ')
    + 'Desbloquea el candado en Configuración (contraseña de sincronización).'
  );
  return false;
}

/** URL de portada borrosa (GitHub groups / ART) */
/** URL de portada borrosa (ART groups o /groups/) */
export function lockedCoverUrl(ART) {
  try {
    if (ART?.groups) {
      const keys = Object.keys(ART.groups);
      const hit = keys.find((k) => {
        const low = k.toLowerCase().replace(/\s+/g, '_');
        return low === 'blur_candado'
          || low.includes('blur_candado')
          || /blur[_\s-]*candado/i.test(k);
      });
      if (hit && ART.groups[hit]) return ART.groups[hit];
      // A veces la clave es la ruta completa del módulo
      for (const k of keys) {
        if (/blur[_\s-]*candado/i.test(k) && ART.groups[k]) return ART.groups[k];
      }
    }
  } catch (_) {}
  return '';
}

const PUBLIC_CANDIDATES = [
  '/groups/Blur_candado.PNG',
  '/groups/Blur_candado.png',
  '/groups/Blur_candado.webp',
  '/groups/Blur_candado.WEBP',
  '/groups/blur_candado.png',
  '/groups/blur_candado.PNG',
];

export function lockedCoverNode(ART) {
  const d = document.createElement('div');
  d.className = 'cover locked-cover';
  d.setAttribute('aria-label', 'Contenido bloqueado');
  const img = new Image();
  img.alt = '';
  img.draggable = false;
  const list = [];
  const fromArt = lockedCoverUrl(ART);
  if (fromArt) list.push(fromArt);
  for (const u of PUBLIC_CANDIDATES) if (!list.includes(u)) list.push(u);
  let i = 0;
  const tryNext = () => {
    if (i >= list.length) {
      img.remove();
      d.textContent = '🔒';
      d.classList.add('locked-cover-fallback');
      return;
    }
    img.src = list[i++];
  };
  img.onload = () => {
    if (!d.contains(img)) d.replaceChildren(img);
  };
  img.onerror = () => tryNext();
  d.append(img);
  tryNext();
  return d;
}
