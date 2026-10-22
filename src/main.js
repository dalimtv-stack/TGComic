import './style.css';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import * as zip from '@zip.js/zip.js';
import { createExtractorFromData } from 'node-unrar-js';
import rarWasm from 'node-unrar-js/esm/js/unrar.wasm?url';
import * as sync from './sync.js';
import { buildSearchIndex, filterSearchIndex } from './search.js';
import {
  stripExt, clean, parseComicName, comicSourceName, issueDisplay, comicDisplay,
  seriesBase, groupSeries, issueLabel, parseComicCaption, buildComicCaption,
} from './parse.js';
import {
  getPageIndex, setPageIndex, getPagesTotal, setPagesTotal,
  getPageFormat, setPageFormat, detectPageFormats,
  isComicRead, readProgress, markComicRead, markComicUnread,
  markSeriesRead, markSeriesUnread,
  setLastRead, getContinueList, listUnfinishedProgress, clearAllReadingData,
  clearComicProgress, migrateLegacyProgress,
} from './progress.js';
import {
  ungroupMap, setUngroupMode,
  seriesDisplayName, setSeriesDisplayName,
  comicDisplayName, setComicDisplayName,
  getCoverFit, setCoverFit,
  getComicSeriesOverride, setComicSeries, seriesOverrideFor,
  channelDisplayName, setChannelDisplayName,
  groupDisplayName, setGroupDisplayName,
} from './meta.js';
import { createReader } from './reader.js';
import { createCovers } from './covers.js';
import { createRepackTool } from './repack.js';
import { createUploadTool } from './upload.js';
import { createPageCache } from './pageCache.js';
import { createJobQueue } from './jobQueue.js';
import { createProTools } from './protools.js';
import { createUi } from './ui.js';
import { createViews } from './views.js';
import { createInfoEdit } from './info.js';
import { exportLibraryData, importLibraryData, downloadJson } from './dataPort.js';
import {
  comicVineConfigured, searchIssuesSmart, fetchIssueDetail, buildSearchQuery,
  listIssuesForVolume, listAllIssuesForVolume, parseVolumeIdFromUrl,
} from './comicvine.js';
import * as locks from './lock.js';
import { initBalance } from './balance.js';
import { collapseVersions, flattenVersions, QUALITIES, QUALITY_LABEL } from './quality.js';

const apiId = Number(import.meta.env.VITE_API_ID);
const apiHash = import.meta.env.VITE_API_HASH;
zip.configure({ useWebWorkers: false });

// ---------- Utilidades ----------
const SEP = '::', TSEP = ':', POST = SEP + 'tgstorage', LIBRARY = 'comics', MB = 1024 * 1024;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const pref = (k, d) => localStorage.getItem('pref:' + k) || d;
const setPref = (k, v) => { localStorage.setItem('pref:' + k, v); try { sync.schedulePush(); } catch (_) {} };

// Ajustes SOLO de este dispositivo (tamaño de portadas y textos): prefijo propio 'device:'.
// No pasan por setPref → nunca se envían ni se reciben en la sincronización entre dispositivos.
const DEV_PREFIX = 'device:';
const COVER_KEYS = ['coverHComic', 'coverHSeries', 'coverHChannel', 'coverTextComic', 'coverTextSeries', 'coverTextChannel'];
const devPref = (k, d) => {
  try { const v = localStorage.getItem(DEV_PREFIX + k); return v == null || v === '' ? d : v; } catch { return d; }
};
const setDevPref = (k, v) => { try { localStorage.setItem(DEV_PREFIX + k, String(v)); } catch (_) {} };
// Migración: valores antiguos pref:cover* (se sincronizaban) → locales; se borran de pref:* para que no vuelvan a viajar
(() => {
  try {
    for (const k of COVER_KEYS) {
      const old = localStorage.getItem('pref:' + k);
      if (old == null) continue;
      if (localStorage.getItem(DEV_PREFIX + k) == null) localStorage.setItem(DEV_PREFIX + k, old);
      localStorage.removeItem('pref:' + k);
    }
  } catch (_) {}
})();
/** Evita el zoom atascado de iOS al girar el dispositivo */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const uiApi = createUi({
  el,
  sync,
  pref: (k, d) => localStorage.getItem('pref:' + k) || d,
  setPref: (k, v) => { localStorage.setItem('pref:' + k, v); try { sync.schedulePush(); } catch (_) {} },
  getApp: () => document.querySelector('#app'),
});
const {
  resetMobileViewport, setBlobImg,
  appDialog, appAlert, appConfirm, appPrompt,
  lockAppScroll, unlockAppScroll,
  bindLongPress, formatPeople, copyInfoFrameText, showDescriptionPanel,
  grid, sheet,
} = uiApi;
const $ = uiApi.$ || ((s) => document.querySelector(s));


// Progreso por canal+mensaje (evita colisiones entre canales)
const sizeLabel = (f, ch) => {
  const mb = `${Math.round(f.size / MB)} MB`;
  const tot = ch ? getPagesTotal(ch.id, f.id) : 0;
  return tot > 0 ? `${mb} · ${tot} pág.` : mb;
};
const pagesOf = (entries) => entries.filter((e) => !e.directory && /\.(jpe?g|png|webp|gif|avif)$/i.test(e.filename)).sort((a, b) => natural(a.filename, b.filename));

// Caché persistente (IndexedDB): biblioteca, listados y portadas
const kv = (() => {
  const db = new Promise((res, rej) => {
    const r = indexedDB.open('tgcomic', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await db;
    return new Promise((res, rej) => { const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error); });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => {}),
    del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => {}),
    keys: () => tx('readonly', (s) => s.getAllKeys()).catch(() => []),
    entries: async () => {
      try {
        const d = await db;
        return await new Promise((res, rej) => {
          const t = d.transaction('kv', 'readonly');
          const s = t.objectStore('kv');
          const out = [];
          const req = s.openCursor();
          req.onsuccess = (e) => {
            const cur = e.target.result;
            if (cur) { out.push([cur.key, cur.value]); cur.continue(); }
            else res(out);
          };
          req.onerror = () => rej(req.error);
          t.onerror = () => rej(t.error);
        });
      } catch {
        return [];
      }
    },
  };
})();

const formatBytes = (n) => {
  n = Math.max(0, Number(n) || 0);
  if (n < 1024) return n + ' B';
  if (n < MB) return (n / 1024).toFixed(1) + ' KB';
  if (n < MB * 1024) return (n / MB).toFixed(1) + ' MB';
  return (n / (MB * 1024)).toFixed(2) + ' GB';
};
const sizeOfVal = (v) => {
  if (v == null) return 0;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size || 0;
  if (v instanceof ArrayBuffer) return v.byteLength || 0;
  if (ArrayBuffer.isView?.(v)) return v.byteLength || 0;
  if (typeof v === 'string') return new Blob([v]).size;
  if (typeof v === 'object') {
    if (v.blob instanceof Blob) return (v.blob.size || 0) + sizeOfVal({ ...v, blob: null });
    try { return new Blob([JSON.stringify(v)]).size; } catch { return 0; }
  }
  return 0;
};

const earlyPref = (k, d = '') => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : v;
  } catch { return d; }
};


function applyCoverSizePrefs() {
  try {
    const root = document.documentElement;
    const p = devPref;
    // Preferencia = altura deseada; el ancho de celda es alto × 2/3 (ratio 2:3)
    const comic = Math.max(100, Math.min(400, +(p('coverHComic', '225') || 225)));
    const series = Math.max(100, Math.min(400, +(p('coverHSeries', '225') || 225)));
    const channel = Math.max(100, Math.min(400, +(p('coverHChannel', '225') || 225)));
    const wComic = Math.round(comic * 2 / 3);
    const wSeries = Math.round(series * 2 / 3);
    const wChannel = Math.round(channel * 2 / 3);
    const tComic = Math.max(8, Math.min(32, +(p('coverTextComic', '15') || 15)));
    const tSeries = Math.max(8, Math.min(32, +(p('coverTextSeries', '15') || 15)));
    const tChannel = Math.max(8, Math.min(32, +(p('coverTextChannel', '15') || 15)));
    root.style.setProperty('--cover-h-comic', comic + 'px');
    root.style.setProperty('--cover-h-series', series + 'px');
    root.style.setProperty('--cover-h-channel', channel + 'px');
    root.style.setProperty('--cover-w-comic', wComic + 'px');
    root.style.setProperty('--cover-w-series', wSeries + 'px');
    root.style.setProperty('--cover-w-channel', wChannel + 'px');
    root.style.setProperty('--cover-grid-min', wComic + 'px');
    root.style.setProperty('--text-comic', tComic + 'px');
    root.style.setProperty('--text-series', tSeries + 'px');
    root.style.setProperty('--text-channel', tChannel + 'px');
    window.dispatchEvent(new Event('covers-resized')); // re-equilibra los títulos con el nuevo tamaño
  } catch (_) {}
}
try { applyCoverSizePrefs(); } catch (_) {}
try { window.applyCoverSizePrefs = applyCoverSizePrefs; } catch (_) {}

/** Rejilla local (device:, no se sincroniza): fill | fixed */
function applyGridLayoutPref() {
  try {
    const v = (typeof devPref === 'function' ? devPref('gridLayout', 'fill') : null)
      || localStorage.getItem('device:gridLayout')
      || 'fill';
    document.documentElement.setAttribute('data-grid-layout', v === 'fixed' ? 'fixed' : 'fill');
  } catch (_) {
    try { document.documentElement.setAttribute('data-grid-layout', 'fill'); } catch (_) {}
  }
}
try { applyGridLayoutPref(); } catch (_) {}
try { window.applyGridLayoutPref = applyGridLayoutPref; } catch (_) {}
// Si otra pestaña cambia los tamaños de este dispositivo, aplicarlos aquí también
try {
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith(DEV_PREFIX)) applyCoverSizePrefs();
  });
} catch (_) {}

const pageCache = createPageCache({ kv, pref: earlyPref });
let jobQueue = null;

async function collectAppStats() {
  const entries = await kv.entries();
  let covers = 0, art = 0, coverN = 0, artN = 0;
  let listsBytes = 0, listsN = 0; // lib + f:* listados
  let pcBytes = 0, pcN = 0;       // pc:* caché de páginas de lectura
  let other = 0;                 // resto residual (casi nada si todo está clasificado)
  for (const [k, v] of entries) {
    const sz = sizeOfVal(v);
    if (typeof k !== 'string') { other += sz; continue; }
    if (k.startsWith('c:')) { covers += sz; coverN++; }
    else if (k.startsWith('art:') || k.startsWith('cc:') || k.startsWith('sc:') || k.startsWith('gc:')) {
      art += sz; artN++;
    }
    else if (k === 'lib' || k.startsWith('f:')) { listsBytes += sz; listsN++; }
    else if (k === 'pc:index' || k.startsWith('pc:')) { pcBytes += sz; pcN++; }
    else other += sz;
  }
  const idbTotal = covers + art + listsBytes + pcBytes + other;

  let lsBytes = 0;
  let sessionBytes = 0;
  let sessionOk = false;
  const lsKeys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const val = localStorage.getItem(k) || '';
      const s = k.length + val.length;
      // UTF-16 ≈ 2 bytes/char in localStorage
      const bytes = s * 2;
      lsBytes += bytes;
      lsKeys.push(k);
      if (k === 'tg_session') {
        sessionBytes = bytes;
        sessionOk = val.length > 0;
      }
    }
  } catch (_) {}

  const channels = Array.isArray(LIB) ? LIB.length : 0;
  let comics = 0, telegramBytes = 0;
  if (Array.isArray(LIB)) {
    for (const ch of LIB) {
      const files = (await kv.get('f:' + ch.id)) || [];
      comics += files.length;
      for (const f of files) telegramBytes += Number(f.size) || 0;
    }
  }

  let pageCacheBytes = 0, pageCacheCount = 0, pageCacheLimitMB = 500;
  try {
    const pcs = await pageCache.stats();
    pageCacheBytes = pcs.bytes || 0;
    pageCacheCount = pcs.count || 0;
    pageCacheLimitMB = pcs.limitMB || 500;
  } catch (_) {}

  let lastSync = '';
  try {
    const s = localStorage.getItem('sync:meta');
    if (s) {
      const j = JSON.parse(s);
      lastSync = j?.updatedAt || j?.lastAt || '';
    }
  } catch (_) {}

  let failedUploads = 0;
  try {
    if (jobQueue) failedUploads = jobQueue.failedJobs().length;
    else {
      const raw = JSON.parse(localStorage.getItem('jobQueue:v1') || '[]');
      failedUploads = Array.isArray(raw)
        ? raw.filter((j) => j.status === 'error' || j.status === 'interrupted').length
        : 0;
    }
  } catch (_) {}

  return {
    idbTotal, covers, art, other, coverN, artN,
    listsBytes, listsN,
    lsBytes, sessionBytes, sessionOk, lsKeyCount: lsKeys.length,
    channels, comics, telegramBytes,
    pageCacheBytes, pageCacheCount, pageCacheLimitMB,
    lastSync, failedUploads,
  };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const j = k++; out[j] = await fn(items[j]); } }));
  return out;
}

// ---------- Telegram (convención tgstorage) ----------
let client, ready;
const partSize = (size) => (size <= 100 * MB ? 128 : size <= 750 * MB ? 256 : 512) * 1024;
const peerOf = (ch) => new Api.InputPeerChannel({ channelId: bigInt(ch.id), accessHash: bigInt(ch.hash) });

async function connect() {
  const session = new StringSession(localStorage.getItem('tg_session') || '');
  client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5, useWSS: true });
  await client.start({
    phoneNumber: async () => (await appPrompt('Teléfono con prefijo (+34...)', 'Inicio de sesión', '', 'tel')) || '',
    phoneCode: async () => (await appPrompt('Código recibido en Telegram', 'Código', '', 'text')) || '',
    password: async () => (await appPrompt('Contraseña de verificación en dos pasos', '2FA', '', 'password')) || '',
    onError: (e) => { appAlert(e?.message || String(e), 'Error'); },
  });
  localStorage.setItem('tg_session', client.session.save());
}

function parseFolder(title) {
  if (!title.endsWith(POST)) return null;
  const [full, category = ''] = title.slice(0, -POST.length).split(SEP);
  const [name, group = ''] = full.split(TSEP);
  return { name, group: group || 'Sin editorial', category };
}

async function refreshLibrary() {
  await ready;
  const found = new Map();
  const add = (ch) => {
    if (ch?.className !== 'Channel') return;
    const info = parseFolder(ch.title || '');
    if (info && info.category.toLowerCase() === LIBRARY) found.set(String(ch.id), { id: String(ch.id), hash: String(ch.accessHash), name: info.name, group: info.group });
  };
  try { (await client.invoke(new Api.contacts.Search({ q: POST, limit: 100 }))).chats.forEach(add); } catch (e) { console.warn(e); }
  for await (const d of client.iterDialogs({})) add(d.entity);
  const lib = [...found.values()];
  await kv.set('lib', lib);
  return lib;
}

/** Invalida cachés locales de un cómic (mensaje Telegram, portada, páginas). */
async function invalidateComicLocal(ch, f) {
  if (!ch?.id || f?.id == null) return;
  const k = String(ch.id) + ':' + String(f.id);
  try { msgs.delete(k); } catch (_) {}
  try { await kv.del(`c:${ch.id}:${f.id}`); } catch (_) {}
  try { await pageCache?.clearComic?.(ch.id, f.id); } catch (_) {}
}

async function fetchFiles(ch) {
  await ready;
  let prev = [];
  try { prev = (await kv.get('f:' + ch.id)) || []; } catch (_) { prev = []; }
  // prev puede traer entradas agrupadas (con variants): aplanar para detectar cambios en cualquier versión
  const prevById = new Map(flattenVersions(Array.isArray(prev) ? prev : []).map((x) => [String(x.id), x]));

  const out = [];
  for await (const m of client.iterMessages(peerOf(ch), { filter: new Api.InputMessagesFilterDocument(), limit: 100000 })) {
    const name = m.document?.attributes?.find((a) => a.className === 'DocumentAttributeFilename')?.fileName;
    if (!name || !/\.cb[zr]$/i.test(name)) continue;
    const caption = String(m.message || '').trim();
    out.push({
      id: m.id,
      name,
      size: Number(m.document.size.toString()),
      caption: caption || undefined,
      forwarded: !!(m.fwdFrom),
    });
  }
  out.sort((a, b) => natural(a.name, b.name));

  // Archivo editado en Telegram (mismo id, otro tamaño/nombre): invalidar cachés
  for (const f of out) {
    const old = prevById.get(String(f.id));
    if (!old) continue;
    if (Number(old.size) !== Number(f.size) || String(old.name || '') !== String(f.name || '')) {
      try { await invalidateComicLocal(ch, f); } catch (_) {}
    }
  }

  // Versiones de calidad del mismo cómic (Alta / [WebP] Media / [2400px][WebP] Baja): una sola entrada
  const grouped = collapseVersions(out);
  await kv.set('f:' + ch.id, grouped);
  return grouped;
}

const msgs = new Map();
async function getMsg(ch, f, opts = {}) {
  const k = String(ch.id) + ':' + String(f.id);
  if (opts.force) {
    try { msgs.delete(k); } catch (_) {}
  }
  if (!msgs.has(k)) {
    await ready;
    const p = client.getMessages(peerOf(ch), { ids: [f.id] })
      .then((r) => r[0])
      .catch((e) => {
        msgs.delete(k);
        throw e;
      });
    msgs.set(k, p);
  }
  let msg = await msgs.get(k);
  // Si el tamaño del listado no coincide con el del documento en memoria → re-fetch
  try {
    const docSize = msg?.document?.size != null ? Number(msg.document.size.toString()) : null;
    const listSize = f?.size != null ? Number(f.size) : null;
    if (docSize != null && listSize != null && docSize !== listSize && !opts._retried) {
      msgs.delete(k);
      return getMsg(ch, f, { force: true, _retried: true });
    }
  } catch (_) {}
  return msg;
}

// Reader de zip.js: pide a Telegram solo los trozos necesarios (en paralelo, caché LRU)
class TgReader extends zip.Reader {
  constructor(msg, size) { super(); this.msg = msg; this.size = size; this.ch = partSize(size); this.max = Math.max(8, Math.floor((48 * MB) / this.ch)); this.cache = new Map(); }
  chunk(i) {
    let p = this.cache.get(i);
    if (p) { this.cache.delete(i); this.cache.set(i, p); return p; }
    p = (async () => {
      let lastErr;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const it = client.iterDownload({ file: this.msg.media, offset: bigInt(i * this.ch), requestSize: this.ch, limit: 1, fileSize: bigInt(this.size) });
          for await (const c of it) return new Uint8Array(c);
          return new Uint8Array(0);
        } catch (err) {
          lastErr = err;
          const em = String(err?.errorMessage || err?.message || err || '');
          // Telegram a veces devuelve "Timeout" (no "TIMEOUT"); gramjs no reintenta
          if (/timeout/i.test(em) || err?.code === -503 || /FLOOD/i.test(em)) {
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1) + Math.random() * 300));
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    })();
    p.catch(() => this.cache.delete(i));
    this.cache.set(i, p);
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value);
    return p;
  }
  async readUint8Array(offset, length) {
    const end = Math.min(offset + length, this.size);
    if (end <= offset) return new Uint8Array(0);
    const first = Math.floor(offset / this.ch), last = Math.floor((end - 1) / this.ch);
    const idx = Array.from({ length: last - first + 1 }, (_, k) => first + k);
    const chunks = await mapLimit(idx, 8, (i) => this.chunk(i));
    const out = new Uint8Array(end - offset);
    idx.forEach((i, k) => {
      const s = Math.max(offset, i * this.ch), e = Math.min(end, i * this.ch + chunks[k].length);
      if (e > s) out.set(chunks[k].subarray(s - i * this.ch, e - i * this.ch), s - offset);
    });
    return out;
  }
}

// ---------- Archivos: ZIP (acceso aleatorio) o RAR (descarga completa) ----------
const pageBlob = async (p) => p.blob || (await p.getData(new zip.BlobWriter(zip.getMimeType(p.filename))));
const sniff = async (r) => { const h = await r.readUint8Array(0, 4); return h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 ? 'rar' : 'zip'; }; // "Rar!"
const cancelled = (ac) => !!(ac && ac.cancelled);
const abortErr = () => Object.assign(new Error('cancelled'), { cancelled: true });

async function downloadRarBytes(m, size, status, ac) {
  // 1) downloadMedia: workers internos y mejor manejo de DC
  try {
    const buf = await client.downloadMedia(m.media, {
      workers: 4,
      progressCallback: (got) => {
        if (cancelled(ac)) throw abortErr();
        const n = Number(got?.toString?.() ?? got);
        if (size > 0 && n >= 0) status(`Descargando CBR… ${Math.min(100, Math.round((n / size) * 100))}%`);
      },
    });
    if (cancelled(ac)) throw abortErr();
    if (buf) {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (u8.byteLength > 0) return u8;
    }
  } catch (e) {
    if (e?.cancelled || cancelled(ac)) throw abortErr();
    console.warn('downloadMedia falló, se reintenta por trozos', e);
  }
  // 2) Por trozos, poca concurrencia + reintentos (evita -503 Timeout)
  const r = new TgReader(m, size);
  r.max = 2;
  const total = Math.ceil(size / r.ch);
  const data = new Uint8Array(size);
  let done = 0;
  await mapLimit(Array.from({ length: total }, (_, i) => i), 2, async (i) => {
    if (cancelled(ac)) throw abortErr();
    const chunk = await r.chunk(i);
    if (cancelled(ac)) throw abortErr();
    data.set(chunk, i * r.ch);
    status(`Descargando CBR… ${Math.round((++done / total) * 100)}%`);
  });
  if (cancelled(ac)) throw abortErr();
  return data;
}

async function openPages(m, size, status, ac) {
  const r = new TgReader(m, size);
  if ((await sniff(r)) === 'zip') { // incluye .cbr que en realidad son ZIP
    const zr = new zip.ZipReader(r);
    return { pages: pagesOf(await zr.getEntries()), close: () => zr.close() };
  }
  const data = await downloadRarBytes(m, size, status, ac);
  if (cancelled(ac)) throw abortErr();
  status('Extrayendo páginas…');
  // node-unrar-js exige ArrayBuffer propio (no compartido con vistas parciales)
  const ab = data.buffer.byteLength === data.byteLength && data.byteOffset === 0
    ? data.buffer
    : data.slice().buffer;
  const ex = await createExtractorFromData({
    wasmBinary: await (await fetch(rarWasm)).arrayBuffer(),
    data: ab,
  });
  const mimeOf = (name) => {
    const e = (name.split(/[/\\]/).pop() || name).toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
    if (!e) return 'application/octet-stream';
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' })[e[1]] || 'application/octet-stream';
  };
  const out = [];
  // Generador lazy: hay que recorrerlo entero (solid RAR + liberar memoria C++)
  for (const x of ex.extract().files) {
    if (cancelled(ac)) throw abortErr();
    const n = x.fileHeader.name || '';
    if (x.fileHeader.flags.directory || !x.extraction) continue;
    const base = n.split(/[/\\]/).pop() || n;
    if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
    // Copia real fuera del heap WASM (slice compartido puede corromperse)
    const raw = x.extraction;
    const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (!src.byteLength) continue;
    const copy = new ArrayBuffer(src.byteLength);
    new Uint8Array(copy).set(src);
    out.push({ filename: base, blob: new Blob([copy], { type: mimeOf(base) }) });
    await new Promise((res) => setTimeout(res, 0));
  }
  out.sort((x, y) => natural(x.filename, y.filename));
  if (!out.length) throw new Error('El CBR no contiene imágenes legibles.');
  return { pages: out, close: () => {} };
}

// ---------- Portadas (módulo covers.js) ----------
let reading = false;
const coverApi = createCovers(
  {
    get reading() { return reading; },
    set reading(v) { reading = v; },
  },
  {
    el, kv, zip,
    TgReader, getMsg, pageBlob, sniff, pagesOf,
    readProgress, isComicRead, stripExt,
    getCoverFit,
  }
);
const { getCover, saveCoverBlob, optimizeImageBlob, comicCover, pump, io } = coverApi;

// ---------- Navegación y vistas ----------
const app = $('#app'), titleEl = $('#title'), backBtn = $('#back'), actions = $('#actions');
const top = $('#top');
const h1 = titleEl;
const search = null; // el buscador se crea dentro de cada vista

const stack = [];
function modeBtn(after) {
  const b = el('button', 'btn mode');
  // Muestra el modo ACTUAL (más claro para el usuario)
  const nextOf = { page: 'vertical', vertical: 'horizontal', horizontal: 'page' };
  const labelOf = {
    page: '▯ Página',
    vertical: '☰ Vertical',
    horizontal: '⇔ Horizontal',
  };
  b._label = () => {
    let cur = pref('mode', 'page');
    if (!nextOf[cur]) cur = 'page';
    b.textContent = labelOf[cur] || labelOf.page;
  };
  b.onclick = () => {
    let cur = pref('mode', 'page');
    if (!nextOf[cur]) cur = 'page';
    setPref('mode', nextOf[cur]);
    b._label();
    after?.();
  };
  b._label();
  return b;
}
const menuBtn = el('button', 'btn menu-btn', '☰');
menuBtn.setAttribute('aria-label', 'Menú');
menuBtn.title = 'Menú';
const menuPanel = el('div', 'app-menu');
menuPanel.hidden = true;
const menuInfoBtn = el('button', 'app-menu-item', 'Información');
const menuCfgBtn = el('button', 'app-menu-item', 'Configuración Visor');
const menuAdvBtn = el('button', 'app-menu-item', 'Configuración Avanzada');
const menuSyncBtn = el('button', 'app-menu-item', 'Sincronización');
const menuLockBtn = el('button', 'app-menu-item', '');
const menuUnreadBtn = el('button', 'app-menu-item menu-check', '');
const paintUnreadMenu = () => {
  const on = pref('showUnreadOnly', '0') === '1';
  menuUnreadBtn.textContent = (on ? '✓ ' : '') + 'Mostrar no leídos';
  menuUnreadBtn.classList.toggle('on', on);
};
paintUnreadMenu();
const paintLockMenu = () => {
  if (!locks.canUseLocks()) {
    menuLockBtn.textContent = '🔒 Candado (activa sync)';
    menuLockBtn.disabled = true;
  } else if (locks.isSessionUnlocked()) {
    menuLockBtn.textContent = '🔓 Contenido desbloqueado';
    menuLockBtn.disabled = false;
  } else {
    menuLockBtn.textContent = '🔒 Contenido bloqueado';
    menuLockBtn.disabled = false;
  }
};
paintLockMenu();
const menuRepackBtn = el('button', 'app-menu-item', 'Recargar CBR / externos');
const menuUploadBtn = el('button', 'app-menu-item', 'Subir cómic');
menuPanel.append(menuInfoBtn, menuCfgBtn, menuAdvBtn, menuSyncBtn, menuUploadBtn, menuRepackBtn, menuUnreadBtn, menuLockBtn);
actions.append(menuBtn);
document.body.append(menuPanel);

function closeAppMenu() { menuPanel.hidden = true; menuBtn.classList.remove('on'); }
function toggleAppMenu() {
  const open = menuPanel.hidden;
  if (open) {
    menuPanel.hidden = false;
    menuBtn.classList.add('on');
    // Anclar bajo el botón
    const r = menuBtn.getBoundingClientRect();
    menuPanel.style.top = Math.round(r.bottom + 6) + 'px';
    menuPanel.style.right = Math.round(window.innerWidth - r.right) + 'px';
  } else closeAppMenu();
}
menuBtn.onclick = (ev) => { ev.stopPropagation(); toggleAppMenu(); };
document.addEventListener('click', (ev) => {
  if (!menuPanel.hidden && !menuPanel.contains(ev.target) && ev.target !== menuBtn) closeAppMenu();
});

function showInfoFrame() {
  closeAppMenu();
  document.querySelector('.info-frame')?.remove();
  const frame = el('div', 'info-frame');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Información'));
  const close = el('button', 'btn info-close', '×');
  close.setAttribute('aria-label', 'Cerrar');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-loading', 'Calculando…'));
  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);

  const row = (label, value) => {
    const r = el('div', 'info-row');
    r.append(el('span', 'info-label', label), el('span', 'info-value', value));
    return r;
  };

  // Clic en el título → copiar todo el texto de la ficha
  const titleSpan = head.querySelector('span');
  if (titleSpan) {
    titleSpan.style.cursor = 'pointer';
    titleSpan.title = 'Toca para copiar la información';
  }

  collectAppStats().then((s) => {
    body.replaceChildren();
    const lines = [];
    const sec = (t) => {
      body.append(el('div', 'info-sec', t));
      lines.push('', '## ' + t);
    };
    const add = (label, value) => {
      body.append(row(label, value));
      lines.push(label + ': ' + value);
    };

    sec('Caché (este dispositivo)');
    add('Caché total (IndexedDB)', formatBytes(s.idbTotal));
    add('Carátulas de cómics', formatBytes(s.covers) + ' · ' + s.coverN + ' ítems');
    add('Editoriales y canales', formatBytes(s.art) + ' · ' + s.artN + ' ítems');
    add('Caché de páginas (lectura)', formatBytes(s.pageCacheBytes) + ' · ' + s.pageCacheCount + ' pág. · máx. ' + s.pageCacheLimitMB + ' MB');
    add('Listados de biblioteca', formatBytes(s.listsBytes || 0) + ' · ' + (s.listsN || 0) + ' claves');
    // "Otros" eliminado: era residual (pc:* ya sale en páginas; listados en su fila)

    sec('Sesión y preferencias');
    add('Sesión de Telegram', s.sessionOk ? ('Guardada · ' + formatBytes(s.sessionBytes)) : 'No guardada');
    add('localStorage (prefs, progreso…)', formatBytes(s.lsBytes) + ' · ' + s.lsKeyCount + ' claves');
    add('Última sincronización', s.lastSync
      ? (typeof sync.formatSyncDate === 'function' ? (sync.formatSyncDate(s.lastSync) || s.lastSync) : s.lastSync)
      : '—');
    add('Subidas / recargas fallidas', String(s.failedUploads || 0));

    sec('Biblioteca');
    add('Canales', String(s.channels));
    add('Cómics (listados)', String(s.comics));
    add('Tamaño en Telegram', formatBytes(s.telegramBytes));

    if (titleSpan) {
      titleSpan.onclick = async (ev) => {
        ev.stopPropagation();
        const text = ['Información TGComic', ...lines].filter((x, i) => !(i > 0 && x === '' && lines[i - 1] === '')).join('\n').trim();
        try {
          await navigator.clipboard.writeText(text);
          const prev = titleSpan.textContent;
          titleSpan.textContent = 'Copiado';
          setTimeout(() => { titleSpan.textContent = prev || 'Información'; }, 1200);
        } catch (e) {
          // Fallback
          try {
            const ta = el('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.append(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            titleSpan.textContent = 'Copiado';
            setTimeout(() => { titleSpan.textContent = 'Información'; }, 1200);
          } catch (e2) {
            appAlert('No se pudo copiar');
          }
        }
      };
    }

    body.append(el('div', 'info-sec', 'Datos locales'));
    const expRow = el('div', 'edit-actions');
    const btnExp = el('button', 'btn', 'Exportar JSON');
    btnExp.type = 'button';
    btnExp.onclick = async () => {
      try {
        btnExp.disabled = true;
        btnExp.textContent = 'Exportando…';
        const data = await exportLibraryData({ kv, includeCovers: true });
        downloadJson(data, `tgcomic-meta-${new Date().toISOString().slice(0, 10)}.json`);
      } catch (e) {
        appAlert('Exportación: ' + (e?.message || e));
      } finally {
        btnExp.disabled = false;
        btnExp.textContent = 'Exportar JSON';
      }
    };
    const btnImp = el('button', 'btn', 'Importar JSON');
    btnImp.type = 'button';
    const impInput = el('input');
    impInput.type = 'file';
    impInput.accept = 'application/json,.json';
    impInput.hidden = true;
    btnImp.onclick = () => impInput.click();
    impInput.onchange = async () => {
      const f = impInput.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const r = await importLibraryData(data, { kv });
        appAlert(`Importado: ${r.localStorage} claves, ${r.covers} portadas. Recarga la página.`);
      } catch (e) {
        appAlert('Importación: ' + (e?.message || e));
      }
      impInput.value = '';
    };
    const btnClrPc = el('button', 'btn', 'Vaciar caché páginas');
    btnClrPc.type = 'button';
    btnClrPc.onclick = async () => {
      if (!(await appConfirm('¿Borrar todas las páginas en caché de lectura?', 'Caché'))) return;
      await pageCache.clearAll();
      await appAlert('Caché de páginas vaciada', 'Caché');
    };
    const btnQueue = el('button', 'btn', 'Ver cola');
    btnQueue.type = 'button';
    btnQueue.onclick = () => { try { jobQueue?.show?.(); } catch (_) {} };
    expRow.append(btnExp, btnImp, impInput, btnClrPc, btnQueue);
    body.append(expRow);
  }).catch((err) => {
    body.replaceChildren(el('div', 'info-loading', 'No se pudo calcular: ' + (err?.message || err)));
  });
}
menuInfoBtn.onclick = (ev) => { ev.stopPropagation(); showInfoFrame(); };

function showViewerConfig() {
  closeAppMenu();
  document.querySelector('.info-frame.cfg')?.remove();
  const frame = el('div', 'info-frame cfg');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Configuración Visor'));
  const close = el('button', 'btn info-close', '×');
  close.setAttribute('aria-label', 'Cerrar');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');

  const section = (title) => {
    body.append(el('div', 'info-sec', title));
  };
  const toggleGroup = (options, getVal, setVal, onChange) => {
    const wrap = el('div', 'cfg-group');
    const btns = [];
    const paint = () => {
      const cur = getVal();
      btns.forEach(({ b, val }) => b.classList.toggle('on', val === cur));
    };
    for (const [val, label] of options) {
      const b = el('button', 'cfg-toggle', label);
      b.type = 'button';
      b.onclick = () => {
        setVal(val);
        paint();
        try { onChange?.(val); } catch (_) {}
      };
      btns.push({ b, val });
      wrap.append(b);
    }
    body.append(wrap);
    paint();
    return { wrap, paint };
  };

  section('Visualización páginas');
  // Subopciones solo en Modo Página
  const spreadWrap = el('div', 'cfg-group cfg-sub');
  const spreadBtns = [];
  const paintSpread = () => {
    const on = pref('spread', '0') === '1';
    spreadBtns.forEach(({ b, val }) => b.classList.toggle('on', val === (on ? '1' : '0')));
  };
  for (const [val, label] of [['0', 'Una Página'], ['1', 'Dos Páginas']]) {
    const b = el('button', 'cfg-toggle', label);
    b.type = 'button';
    b.onclick = () => {
      setPref('spread', val);
      paintSpread();
    };
    spreadBtns.push({ b, val });
    spreadWrap.append(b);
  }
  paintSpread();
  const syncSpreadVis = (mode) => {
    const m = mode || (() => {
      const x = pref('mode', 'page');
      return (x === 'vertical' || x === 'horizontal') ? x : 'page';
    })();
    spreadWrap.hidden = m !== 'page';
  };

  toggleGroup(
    [
      ['page', 'Modo Página'],
      ['vertical', 'Modo Vertical'],
      ['horizontal', 'Modo Horizontal'],
    ],
    () => {
      const m = pref('mode', 'page');
      return (m === 'vertical' || m === 'horizontal') ? m : 'page';
    },
    (v) => setPref('mode', v),
    (v) => syncSpreadVis(v)
  );
  body.append(spreadWrap);
  syncSpreadVis();

  section('Calidad');
  toggleGroup(
    QUALITIES.map((q) => [q, QUALITY_LABEL[q]]),
    () => (QUALITIES.includes(pref('quality', 'high')) ? pref('quality', 'high') : 'high'),
    (v) => setPref('quality', v)
  );
  body.append(el('div', 'cfg-hint', 'Se usa la copia con el nombre terminado en [WebP] (Media) o [2400px][WebP] (Baja). Si un cómic no la tiene, se abre la más cercana.'));

  section('Ajuste Páginas');
  toggleGroup(
    [
      ['width', 'Modo Ancho'],
      ['screen', 'Modo Pantalla'],
    ],
    () => (pref('fit', 'screen') === 'width' ? 'width' : 'screen'),
    (v) => setPref('fit', v)
  );

  section('Menú del visor');
  const hideWrap = el('div', 'cfg-field');
  const hideLab = el('label', 'sync-label', 'Ocultar menús tras (segundos). Por defecto 15 segundos.');
  const hideInp = el('input', 'edit-input');
  hideInp.type = 'number';
  hideInp.min = '3';
  hideInp.max = '120';
  hideInp.step = '1';
  hideInp.value = pref('uiHideSec', '15');
  hideInp.onchange = () => {
    let v = Math.max(3, Math.min(120, +hideInp.value || 15));
    hideInp.value = String(v);
    setPref('uiHideSec', String(v));
  };
  hideWrap.append(hideLab, hideInp);
  body.append(hideWrap);

  section('Caché de páginas (lectura)');
  const pcWrap = el('div', 'cfg-field');
  const pcLab = el('label', 'sync-label', 'Máximo de caché de páginas en este dispositivo. Por defecto 500 MB');
  const pcInp = el('input', 'edit-input');
  pcInp.type = 'number';
  pcInp.min = '50';
  pcInp.max = '4000';
  pcInp.step = '50';
  pcInp.value = pref('pageCacheMaxMB', '500');
  pcInp.onchange = () => {
    let v = Math.max(50, Math.min(4000, +pcInp.value || 500));
    pcInp.value = String(v);
    setPref('pageCacheMaxMB', String(v));
  };
  pcWrap.append(pcLab, pcInp);
  body.append(pcWrap);

  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
}
menuCfgBtn.onclick = (ev) => { ev.stopPropagation(); showViewerConfig(); };
menuAdvBtn.onclick = (ev) => {
  ev.stopPropagation();
  try { proTools.showAdvancedConfig(); }
  catch (e) { appAlert('ProTools: ' + (e?.message || e)); }
};


menuLockBtn.onclick = async (ev) => {
  ev.stopPropagation();
  closeAppMenu();
  if (!locks.canUseLocks()) {
    await appAlert('Inicia sesión de sincronización para usar el candado de contenido.', 'Candado');
    return;
  }
  if (locks.isSessionUnlocked()) {
    locks.lockSession();
    paintLockMenu();
    try { groupsView(); } catch (_) {}
    return;
  }
  const pw = await appPrompt(
    'Introduce la contraseña de sincronización para desbloquear el contenido marcado.',
    'Desbloquear contenido',
    '',
    'password'
  );
  if (pw == null) return;
  const ok = await locks.unlockSession(pw);
  if (!ok) {
    await appAlert('Contraseña incorrecta', 'Desbloquear');
    return;
  }
  paintLockMenu();
  try { groupsView(); } catch (_) {}
};

menuRepackBtn.onclick = (ev) => {
  ev.stopPropagation();
  closeAppMenu();
  repackTool.showRepackFrame();
};
menuUploadBtn.onclick = (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
  closeAppMenu();
  // Esperar a que termine el gesto (mouseup/touchend) para que no cierre el overlay
  setTimeout(() => {
    try {
      if (!uploadTool || typeof uploadTool.showUploadFrame !== 'function') {
        appAlert('La herramienta de subida no está disponible. Recarga la página.');
        return;
      }
      uploadTool.showUploadFrame(getUploadContext());
    } catch (e) {
      console.error('[upload] showUploadFrame', e);
      appAlert('Error al abrir subida: ' + (e?.message || e));
    }
  }, 50);
};
menuSyncBtn.onclick = (ev) => {
  ev.stopPropagation();
  closeAppMenu();
  sync.showSyncFrame({
    onAfterAuth: () => {
      // Refrescar vista actual si estamos en biblioteca
      try {
        const e = stack[stack.length - 1];
        if (e && !e._isComic) e.render(e);
      } catch (_) {}
    },
  });
};
menuUnreadBtn.onclick = (ev) => {
  ev.stopPropagation();
  const on = pref('showUnreadOnly', '0') !== '1';
  setPref('showUnreadOnly', on ? '1' : '0');
  paintUnreadMenu();
  closeAppMenu();
  try {
    const e = stack[stack.length - 1];
    if (e && !e._isComic) e.render(e);
    else if (stack.length === 1) groupsView();
  } catch (_) { try { groupsView(); } catch (__) {} }
};

let cleanup = null, LIB = [], synced = false;

function getUploadContext() {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i] && stack[i]._uploadCtx) return stack[i]._uploadCtx;
  }
  return {};
}
function go(title, render) {
  // Guardar posición de scroll de la vista actual antes de entrar en otra
  if (stack.length) {
    const cur = stack[stack.length - 1];
    cur.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  }
  stack.push({ title, render });
  history.pushState(null, '');
  show();
}
let lastScrollY = 0, headerHidden = false;
function show() {
  cleanup?.(); cleanup = null;
  const e = stack[stack.length - 1];
  if (!e || typeof e.render !== 'function') {
    try { msg('Error de navegación. Recarga la página.'); } catch (_) {}
    return;
  }
  titleEl.textContent = e.title || 'Cómics';
  backBtn.hidden = stack.length < 2;
  $('#top')?.classList.toggle('home', stack.length < 2);
  headerHidden = false;
  $('#top')?.classList.remove('hide');
  const restoreY = (typeof e.scrollY === 'number' && e.scrollY > 0) ? e.scrollY : 0;
  const applyScroll = () => {
    try {
      window.scrollTo(0, restoreY);
      document.documentElement.scrollTop = restoreY;
      document.body.scrollTop = restoreY;
      lastScrollY = restoreY;
    } catch (_) {}
  };
  // Al entrar en vista nueva (sin scroll guardado) ir arriba; al volver restaurar
  applyScroll();
  try {
    const ret = e.render(e);
    if (ret && typeof ret.then === 'function') {
      ret.catch((err) => {
        console.error('[show] render async', err);
        try { msg('Error al cargar la vista: ' + (err?.message || err)); } catch (_) {}
      });
    }
  } catch (err) {
    console.error('[show] render', err);
    try { msg('Error al cargar la vista: ' + (err?.message || err)); } catch (_) {}
  }
  try { repackTool?.syncFloatingUi?.(); } catch (_) {}
  try { uploadTool?.syncFloatingUi?.(); } catch (_) {}
  // Render async (canal/serie): reaplicar scroll varias veces
  requestAnimationFrame(() => {
    applyScroll();
    setTimeout(applyScroll, 50);
    setTimeout(applyScroll, 150);
    setTimeout(applyScroll, 350);
  });
}
backBtn.onclick = () => history.back();
// Header: ocultar al bajar, mostrar al subir
const onScrollHeader = () => {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  const top = $('#top');
  if (!top || document.getElementById('rd')) return;
  if (y > lastScrollY + 8 && y > 60) {
    if (!headerHidden) { top.classList.add('hide'); headerHidden = true; }
  } else if (y < lastScrollY - 8) {
    if (headerHidden) { top.classList.remove('hide'); headerHidden = false; }
  }
  lastScrollY = y;
};
addEventListener('scroll', onScrollHeader, { passive: true });

addEventListener('popstate', () => { if (stack.length > 1) { stack.pop(); show(); } });
const msg = (t) => app.replaceChildren(el('div', 'msg', t));
const alive = (e) => stack[stack.length - 1] === e;

// Gesto atrás (borde izquierdo → derecha) SOLO Android.
// En iPhone el gesto nativo del sistema ya hace history.back(); duplicarlo hace doble salto.
(() => {
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  if (!isAndroid) return;
  let sx = null, sy = 0;
  const edge = 28;
  const onStart = (e) => {
    if (document.getElementById('rd')) { sx = null; return; }
    if (document.querySelector('.info-frame, .sheet, .mosaic')) { sx = null; return; }
    if (stack.length < 2) { sx = null; return; }
    if (!e.touches || e.touches.length !== 1) { sx = null; return; }
    const x = e.touches[0].clientX;
    if (x > edge) { sx = null; return; }
    sx = x;
    sy = e.touches[0].clientY;
  };
  const onMove = (e) => {
    if (sx == null || !e.touches?.[0]) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (dx > 14 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      try { e.preventDefault(); } catch (_) {}
    }
  };
  const onEnd = (e) => {
    if (sx == null) return;
    const t = e.changedTouches?.[0];
    const startX = sx;
    sx = null;
    if (!t || document.getElementById('rd')) return;
    if (stack.length < 2) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - sy;
    if (startX <= edge && dx > 56 && Math.abs(dy) < 100) {
      try { history.back(); } catch (_) {}
    }
  };
  document.addEventListener('touchstart', onStart, { passive: true, capture: true });
  document.addEventListener('touchmove', onMove, { passive: false, capture: true });
  document.addEventListener('touchend', onEnd, { passive: true, capture: true });
})();

const ART = { groups: {}, channels: {} };
/** Variantes por nombre base: { label, file, url, primary }[] */
const ART_VARIANTS = { groups: {}, channels: {} };
const artNorm = (s) => s.normalize('NFC').trim().toLowerCase();
const artLoose = (s) => artNorm(String(s || '').replace(/[\s_\-]+/g, ''));
const EXT_PREF = { webp: 0, png: 1, jpg: 2, jpeg: 2, gif: 3, avif: 4 };
const reg = (kind, files) => {
  const buckets = new Map(); // baseNorm -> [{file, url, base, altTag, ext}]
  for (const [p, url] of Object.entries(files)) {
    const file = decodeURIComponent(p.split('/').pop() || '').trim();
    if (!file) continue;
    const m = file.match(/^(.*)\.([a-z0-9]+)$/i);
    if (!m) continue;
    const stem = m[1].trim();
    const ext = m[2].toLowerCase();
    // Cemetery Beach.alt / .alt1 / .alt2 …
    const altM = stem.match(/^(.*)\.(alt\d*|alt)$/i);
    const base = (altM ? altM[1] : stem).trim();
    const altTag = altM ? altM[2].toLowerCase() : '';
    if (!base) continue;
    const bn = artNorm(base);
    if (!buckets.has(bn)) buckets.set(bn, []);
    buckets.get(bn).push({ file, url, base, altTag, ext });
    // Índices de búsqueda rápida → URL primaria (se rellena después)
  }
  for (const [bn, list] of buckets) {
    // Orden: sin alt primero, luego por extensión preferida, luego nombre
    list.sort((a, b) => {
      // 1) extensión (webp → png → jpg…), 2) base antes que .alt / .alt1 / .alt2
      const ea = EXT_PREF[a.ext] ?? 9;
      const eb = EXT_PREF[b.ext] ?? 9;
      if (ea !== eb) return ea - eb;
      const altRank = (t) => {
        if (!t) return 0;
        if (t === 'alt') return 1;
        const mm = String(t).match(/^alt(\d+)$/i);
        return mm ? 1 + parseInt(mm[1], 10) : 40;
      };
      const ar = altRank(a.altTag) - altRank(b.altTag);
      if (ar) return ar;
      return a.file.localeCompare(b.file, undefined, { numeric: true });
    });
    const variants = list.map((it, i) => {
      let label;
      if (!it.altTag) label = i === 0 ? 'Predeterminada (GitHub)' : `GitHub (${it.ext})`;
      else {
        const n = it.altTag.replace(/^alt/i, '') || '';
        label = n ? `Alternativa ${n}` : 'Alternativa';
        // alt, alt1, alt2 → Alternativa / Alternativa 1 / Alternativa 2
        if (it.altTag === 'alt') label = 'Alternativa 1';
        else if (/^alt\d+$/i.test(it.altTag)) label = 'Alternativa ' + it.altTag.replace(/^alt/i, '');
      }
      return {
        label,
        file: it.file,
        url: it.url,
        primary: !it.altTag && i === list.findIndex((x) => !x.altTag),
        altTag: it.altTag,
        ext: it.ext,
        base: it.base,
      };
    });
    // Ajustar labels de predeterminada si hay varias sin .alt
    let altIdx = 1;
    for (const v of variants) {
      if (v.altTag) {
        v.label = v.altTag === 'alt' ? 'Alternativa 1' : (
          /^alt\d+$/i.test(v.altTag)
            ? 'Alternativa ' + v.altTag.replace(/^alt/i, '')
            : 'Alternativa ' + (altIdx++)
        );
      }
    }
    const primary = variants.find((v) => !v.altTag) || variants[0];
    if (!primary) continue;
    const baseName = primary.base;
    ART[kind][artNorm(baseName)] = primary.url;
    ART[kind][baseName.normalize('NFD').trim().toLowerCase()] = primary.url;
    ART[kind][artLoose(baseName)] = primary.url;
    const vKey = artNorm(baseName);
    ART_VARIANTS[kind][vKey] = variants;
    ART_VARIANTS[kind][artLoose(baseName)] = variants;
  }
};
reg('groups', import.meta.glob([
  '/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
  '/src/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
  '../public/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
  '../../public/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
], { eager: true, query: '?url', import: 'default' }));
reg('channels', import.meta.glob([
  '/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
  '/src/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
  '../public/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
  '../../public/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP,GIF,AVIF}',
], { eager: true, query: '?url', import: 'default' }));

/** Lista variantes GitHub para un canal/editorial. */
function listGithubArtVariants(kind, name) {
  const nfc = String(name || '').normalize('NFC').trim();
  if (!nfc) return [];
  const map = ART_VARIANTS[kind] || {};
  let list = map[artNorm(nfc)] || map[artLoose(nfc)] || null;
  if (!list) {
    const target = artLoose(nfc);
    for (const [k, v] of Object.entries(map)) {
      if (artLoose(k) === target) { list = v; break; }
    }
  }
  // Coincidencia parcial: archivo "Foo Bar" vs canal "Foo Bar:Editorial::..."
  if (!list) {
    const target = artLoose(nfc.split(':')[0] || nfc);
    let best = null;
    for (const [k, v] of Object.entries(map)) {
      const kk = artLoose(k);
      if (kk === target || target.startsWith(kk) || kk.startsWith(target)) {
        best = v;
        if (kk === target) break;
      }
    }
    list = best;
  }
  return Array.isArray(list) ? list.slice() : [];
}

/** Prueba rutas estáticas /channels|/groups cuando el glob no indexó public/. */
async function probeGithubArtVariants(kind, name) {
  const nfc = String(name || '').normalize('NFC').trim().split(':')[0].trim();
  if (!nfc) return [];
  const folder = kind === 'groups' ? 'groups' : 'channels';
  const stems = [nfc];
  // variantes de nombre
  const loose = nfc.replace(/_/g, ' ');
  if (loose !== nfc) stems.push(loose);
  const out = [];
  const seen = new Set();
  const MAX_ALT = 30;      // tope de seguridad: alt, alt1 … alt30
  const MAX_MISSES = 3;    // se tolera un hueco (p. ej. falta alt1 pero hay alt2); 3 fallos seguidos = fin
  const MAX_TOTAL = 40;

  // Intenta cargar un archivo concreto; añade la variante a `out` y devuelve true si existe
  const tryFile = async (f) => {
    const key = f.file.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    const urls = [
      `/${folder}/${encodeURIComponent(f.file)}`,
      `/${folder}/${f.file}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { method: 'GET', cache: 'force-cache' });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob || blob.size < 50) continue;
        // El SPA de Vercel devuelve index.html con 200 si no existe: exigir tipo imagen
        const ct = (res.headers.get('content-type') || blob.type || '').toLowerCase();
        if (ct && !ct.includes('image') && !ct.includes('octet')) continue;
        const label = f.altTag
          ? (f.altTag === 'alt' ? 'Alternativa 1' : 'Alternativa ' + f.altTag.replace(/^alt/i, ''))
          : (out.some((x) => !x.altTag) ? `Alternativa (${f.ext})` : 'Predeterminada');
        out.push({
          label,
          file: f.file,
          url,
          primary: !f.altTag && !out.some((x) => x.primary),
          altTag: f.altTag,
          ext: f.ext,
          base: nfc,
          blob, // cache probe
        });
        return true;
      } catch (_) {}
    }
    return false;
  };

  const tags = ['', 'alt', ...Array.from({ length: MAX_ALT }, (_, i) => 'alt' + (i + 1))];
  for (const stem of stems) {
    for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif', 'avif']) {
      let misses = 0;
      for (const tag of tags) {
        if (out.length >= MAX_TOTAL) break;
        const file = tag ? `${stem}.${tag}.${ext}` : `${stem}.${ext}`;
        const ok = await tryFile({ file, altTag: tag, ext });
        if (!tag) continue; // que falte la base no corta la búsqueda de alternativas
        if (ok) misses = 0;
        else if (++misses >= MAX_MISSES) break;
      }
    }
  }
  // Marcar primary la primera sin alt
  const first = out.find((x) => !x.altTag);
  if (first) {
    out.forEach((x) => { x.primary = false; });
    first.primary = true;
    first.label = 'Predeterminada';
  }
  return out;
}


async function fetchOptimizeArtBlob(url, keepAlpha = true) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) return null;
  const blob = await res.blob();
  if (!blob.size) return null;
  // Logos GitHub: si ya son razonables, NO re-encode (Safari/canvas los dejaba negros)
  if (blob.size < 350 * 1024) return blob;
  try {
    const opt = await optimizeImageBlob(blob, 512, 0.85, { keepAlpha: true });
    if (opt && opt.size >= 100) return opt;
  } catch (_) {}
  return blob;
}

async function fetchArtBlob(url, cached) {
  const headers = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.modified) headers['If-Modified-Since'] = cached.modified;
  try {
    const res = await fetch(url, { headers, cache: 'no-cache' });
    if (res.status === 304) return { unchanged: true };
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) return { gone: true };
    const blob = await res.blob();
    if (!blob || !blob.size) return { gone: true };
    return {
      blob,
      etag: res.headers.get('ETag') || cached?.etag || '',
      modified: res.headers.get('Last-Modified') || cached?.modified || '',
    };
  } catch {
    return { gone: true };
  }
}

function art(kind, name, ch) {
  const d = el('div', kind === 'groups' ? 'cover square' : 'cover cover-channel');
  const ltr = el('span', '', name.slice(0, 1).toUpperCase());
  d.append(ltr);
  const nfc = name.normalize('NFC').trim();
  const nfd = name.normalize('NFD').trim();
  const key = `art:${kind}:${artNorm(nfc)}`;
  const exts = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'JPG', 'JPEG', 'PNG', 'WEBP', 'AVIF', 'GIF'];
  // Variantes: espacios, CamelCase (WildStorm → Wild Storm), sin espacios
  // En GitHub el archivo real es p.ej. "Wildstorm.WEBP" (s minúscula)
  const splitCamel = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const noSpace = (s) => String(s || '').replace(/[\s_\-]+/g, '');
  const titleCase = (s) => String(s || '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const nameVars = [...new Set([
    nfc, nfd, name.trim(),
    splitCamel(nfc), splitCamel(nfd),
    noSpace(nfc), noSpace(nfd),
    titleCase(nfc), titleCase(splitCamel(nfc)),
    nfc.toLowerCase(), nfc.toUpperCase(),
  ].filter(Boolean))];
  const candidates = [];
  const seen = new Set();
  const add = (u) => { if (u && !seen.has(u)) { seen.add(u); candidates.push(u); } };
  const artBag = ART[kind] || {};
  const targetLoose = artLoose(nfc);
  for (const n of nameVars) {
    add(artBag[artNorm(n)]);
    add(artBag[artLoose(n)]);
    add(artBag[n.normalize('NFD').trim().toLowerCase()]);
  }
  // Emparejado flexible por mapa ART (WildStorm ↔ Wildstorm ↔ Wild Storm)
  try {
    for (const [k, url] of Object.entries(artBag)) {
      if (artLoose(k) === targetLoose) add(url);
    }
  } catch (_) {}
  for (const n of nameVars) {
    for (const e of exts) {
      add(`/${kind}/${encodeURIComponent(n)}.${e}`);
      add(`/${kind}/${n}.${e}`);
    }
  }

  const showBlob = (blob) => {
    const img = new Image();
    img.onload = () => {
      try { ltr.remove(); } catch (_) {}
      try {
        if (img.naturalWidth > img.naturalHeight) d.classList.add('landscape');
        else d.classList.remove('landscape');
      } catch (_) {}
      const prev = d.querySelector('img');
      if (prev) prev.remove();
      d.append(img);
    };
    setBlobImg(img, blob, d);
  };

  const tryCandidates = async (skipUrl) => {
    for (const url of candidates) {
      if (skipUrl && url === skipUrl) continue;
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob.size) continue;
        let outBlob = blob;
        if (blob.size >= 400 * 1024) {
          try {
            const opt = await optimizeImageBlob(blob, 512, 0.85, { keepAlpha: true });
            if (opt && opt.size >= 100) outBlob = opt;
          } catch (_) {}
        }
        const meta = {
          blob: outBlob,
          url,
          etag: res.headers.get('ETag') || '',
          modified: res.headers.get('Last-Modified') || '',
          optimized: true,
        };
        await kv.set(key, meta);
        if (d.isConnected) showBlob(meta.blob);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  };

  // Sin imagen en GitHub → portada de algún cómic del canal
  const fallbackComic = async () => {
    if (kind !== 'channels' || !ch) return false;
    try {
      const b = await firstAvailableCover(ch, null);
      if (!b) return false;
      await kv.set(key, { blob: b, url: `comic:${ch.id}:auto`, fromComic: true });
      if (d.isConnected) showBlob(b);
      return true;
    } catch (_) {
      return false;
    }
  };

  (async () => {
    const cached = await kv.get(key);
    if (cached?.blob) showBlob(cached.blob);

    // Caché de GitHub: revalidar
    if (cached?.blob && cached?.url && !cached.fromComic) {
      const fresh = await fetchArtBlob(cached.url, cached);
      if (fresh?.unchanged) return;
      if (fresh?.blob) {
        if (fresh.blob && fresh.blob.size >= 400 * 1024) {
          try {
            const opt = await optimizeImageBlob(fresh.blob, 512, 0.85, { keepAlpha: true });
            if (opt && opt.size >= 100) fresh.blob = opt;
          } catch (_) {}
        }
        fresh.url = cached.url;
        fresh.optimized = true;
        await kv.set(key, fresh);
        if (d.isConnected) showBlob(fresh.blob);
        return;
      }
      const found = await tryCandidates(cached.url);
      if (!found) {
        try { await kv.del(key); } catch (_) {}
        await fallbackComic();
      }
      return;
    }

    // Caché desde cómic: intentar GitHub por si subieron imagen después
    if (cached?.fromComic) {
      const found = await tryCandidates();
      if (!found) return; // se mantiene la del cómic
      return;
    }

    // Sin caché
    const found = await tryCandidates();
    if (!found) await fallbackComic();
  })();

  return d;
}

/** Pulsación larga: el menú se abre AL SOLTAR (si no, el touchend cierra el sheet) */

let infoApi;
try {
infoApi = createInfoEdit({
  el, kv,
  get client() { return client; },
  Api,
  peerOf,
  get ready() { return ready; },
  get LIB() { return LIB; },
  locks,
  parseComicName, comicSourceName, issueDisplay, comicDisplay, clean, stripExt,
  parseComicCaption, buildComicCaption,
  groupSeries, seriesOverrideFor, seriesBase, issueLabel,
  comicDisplayName, setComicDisplayName,
  getCoverFit, setCoverFit,
  getMsg, openPages, pageBlob,
  seriesDisplayName, setSeriesDisplayName,
  channelDisplayName, setChannelDisplayName,
  groupDisplayName, setGroupDisplayName,
  getComicSeriesOverride, setComicSeries, ungroupMap, setUngroupMode,
  getPageIndex, getPagesTotal, getPageFormat, formatBytes, sizeLabel,
  getCover, saveCoverBlob, optimizeImageBlob, comicCover, io,
  art, ART, artNorm, artLoose, listGithubArtVariants, probeGithubArtVariants,
  fetchOptimizeArtBlob,
  setBlobImg,
  appAlert, appConfirm, appPrompt, sheet, bindLongPress, grid, copyInfoFrameText, formatPeople, showDescriptionPanel,
  comicVineConfigured, searchIssuesSmart, fetchIssueDetail, buildSearchQuery,
  listIssuesForVolume, listAllIssuesForVolume, parseVolumeIdFromUrl,
  go, show, stack, natural,
});
} catch (e) {
  console.error('[info] createInfoEdit falló', e);
  infoApi = {};
}
const showComicInfo = infoApi.showComicInfo || (() => {});
const showCaptionEditor = infoApi.showCaptionEditor || (() => {});
const showComicVinePicker = infoApi.showComicVinePicker || (() => {});
const showEditComicTitle = infoApi.showEditComicTitle || (() => {});
const showCoverFitEditor = infoApi.showCoverFitEditor || (() => {});
const showPickCoverFromComic = infoApi.showPickCoverFromComic || (() => {});
const showSeriesInfo = infoApi.showSeriesInfo || (() => {});
const showEditSeries = infoApi.showEditSeries || (() => {});
const showEditSeriesName = infoApi.showEditSeriesName || (() => {});
const showSeriesCoverPicker = infoApi.showSeriesCoverPicker || (() => {});
const seriesCoverNode = infoApi.seriesCoverNode || ((ch, lab, files) => el('div', 'cover'));
const channelCoverNode = infoApi.channelCoverNode || ((ch) => el('div', 'cover'));
const groupCoverNode = infoApi.groupCoverNode || ((n) => el('div', 'cover square'));
const showGroupInfo = infoApi.showGroupInfo || (() => {});
const showEditGroup = infoApi.showEditGroup || (() => {});
const showEditGroupName = infoApi.showEditGroupName || (() => {});
const showGroupCoverPicker = infoApi.showGroupCoverPicker || (() => {});
const showChannelInfo = infoApi.showChannelInfo || (() => {});
const showEditChannel = infoApi.showEditChannel || (() => {});
const showEditChannelName = infoApi.showEditChannelName || (() => {});
const showChannelCoverPicker = infoApi.showChannelCoverPicker || (() => {});
const getChannelCoverBlob = infoApi.getChannelCoverBlob;
const setChannelCoverBlob = infoApi.setChannelCoverBlob;
const clearChannelCover = infoApi.clearChannelCover;
const getSeriesCoverBlob = infoApi.getSeriesCoverBlob;
const setSeriesCoverBlob = infoApi.setSeriesCoverBlob;
const firstAvailableCover = infoApi.firstAvailableCover || (async () => null);
const getGithubChannelArtBlob = infoApi.getGithubChannelArtBlob || (async () => null);
const getGithubGroupArtBlob = infoApi.getGithubGroupArtBlob || (async () => null);






// ---------- Lector (módulo reader.js) ----------
jobQueue = createJobQueue({ el, pref: earlyPref });

const readerApi = createReader(
  {
    get cleanup() { return cleanup; },
    set cleanup(v) { cleanup = v; },
    get reading() { return reading; },
    set reading(v) { reading = v; },
    pump,
    get stack() { return stack; },
  },
  {
    el, $,
    pageBlob,
    getPageIndex, setPageIndex, setPagesTotal, setPageFormat, detectPageFormats,
    pref, setPref,
    resetMobileViewport,
    comicDisplayName, comicDisplay, stripExt,
    setLastRead,
    kv, fetchFiles, groupSeries, seriesOverrideFor,
    getMsg, openPages, saveCoverBlob,
    msg, alive, cancelled,
    show, go,
    modeBtn,
    pageCache,
  }
);
const { openComic: openComicRaw } = readerApi;
function openComic(ch, f, queue, opts) {
  const lab = comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch?.name) || '');
  if (!locks.guardRestricted('comic', { ch, f }, lab)) return;
  return openComicRaw(ch, f, queue, opts);
}

const viewsApi = createViews({
  el, app, top, h1, actions, search,
  titleEl,
  setLastScrollY: (y) => { lastScrollY = y; },
  fetchFiles,
  mapLimit,
  alive,
  getMsg,
  get client() { return client; },
  get ready() { return ready; },

  get LIB() { return LIB; },
  get synced() { return synced; },
  msg,
  buildSearchIndex,
  filterSearchIndex,
  listUnfinishedProgress,
  get repackTool() { return repackTool; },
  locks, ART,
  groupDisplayName, channelDisplayName, seriesDisplayName, comicDisplayName,
  comicDisplay, comicSourceName, issueLabel, groupSeries, seriesOverrideFor,
  clean, stripExt, sizeLabel, formatBytes,
  art, groupCoverNode, channelCoverNode, seriesCoverNode,
  getCover, comicCover, io,
  go, show, stack,
  get openComic() { return openComic; },
  sheet, bindLongPress, grid,
  showGroupInfo, showEditGroup, showChannelInfo, showEditChannel,
  showSeriesInfo, showEditSeries, showComicInfo, showEditComicTitle,
  showCoverFitEditor, showPickCoverFromComic, getCoverFit,
  getContinueList, readProgress, isComicRead, markComicRead, markComicUnread,
  markSeriesRead, markSeriesUnread, getPageIndex, getPagesTotal,
  ungroupMap, setUngroupMode, getComicSeriesOverride,
  firstAvailableCover, kv, natural,
  pref, setPref,
  appAlert, appConfirm, appPrompt,
  parseComicName, issueDisplay,
  seriesBase,
  setBlobImg,
});
const { cardNode, lockToggleOpts, groupsView, channelsView, filesView, seriesView } = viewsApi;

// ---------- Recarga CBR / externos ----------
const repackTool = createRepackTool({
  el,
  jobQueue,
  get client() { return client; },
  Api, bigInt,
  get LIB() { return LIB; },
  kv,
  get ready() { return ready; },
  peerOf,
  fetchFiles, getMsg, openPages, pageBlob,
  downloadRarBytes, sniff, TgReader, pagesOf,
  natural,
  parseComicName,
  parseComicCaption,
  buildComicCaption,
  comicDisplay,
  comicDisplayName,
  seriesDisplayName,
  getComicSeriesOverride,
  seriesBase,
  stripExt,
  getIsHome: () => stack.length < 2 && !document.getElementById('rd'),
  formatBytes: (n) => {
    const x = Number(n) || 0;
    if (x < 1024) return x + ' B';
    if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
    return (x / (1024 * 1024)).toFixed(2) + ' MB';
  },
  onUploadDone: async (ch, meta = {}) => {
    // Misma lógica que subida: refrescar listado actual
    try {
      if (ch?.id) await fetchFiles(ch);
    } catch (_) {}
    try {
      const names = [].concat(meta.outNames || [], meta.outName ? [meta.outName] : [])
        .map((n) => String(n || '').toLowerCase());
      if (ch?.id && names.length) {
        let files = [];
        try { files = await kv.get('f:' + ch.id) || []; } catch (_) {}
        for (const f of files || []) {
          const fn = String(f?.name || '').toLowerCase();
          if (names.some((n) => n && fn === n)) {
            try { clearComicProgress(ch.id, f.id); } catch (_) {}
          }
        }
      }
    } catch (_) {}
    try {
      const top = stack[stack.length - 1];
      if (top) top.scrollY = window.scrollY || 0;
      show();
    } catch (_) {}
  },
});



let uploadTool = {
  showUploadFrame() {
    appAlert('Subida no disponible. Revisa la consola o recarga la página.');
  },
  syncFloatingUi() {},
  hideFloatingUi() {},
};
try {
  uploadTool = createUploadTool({
    el,
    jobQueue,
    get client() { return client; },
    Api, bigInt,
    get LIB() { return LIB; },
    setLIB: (v) => { LIB = v; },
    kv,
    get ready() { return ready; },
    peerOf,
    fetchFiles,
    refreshLibrary,
    natural,
    get showComicVinePicker() { return showComicVinePicker; },
    getIsHome: () => stack.length < 2 && !document.getElementById('rd'),
    formatBytes: (n) => {
      const x = Number(n) || 0;
      if (x < 1024) return x + ' B';
      if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
      return (x / (1024 * 1024)).toFixed(2) + ' MB';
    },
    // Tras subir: refrescar lo que el usuario está viendo (canal, serie, editorial o home)
    onUploadDone: async (ch, meta = {}) => {
      if (!ch?.id) return;
      let files = [];
      try { files = await fetchFiles(ch); } catch (_) {}
      // Cómics recién subidos: nunca deben heredar progreso de otro mensaje con el mismo id
      try {
        const names = [].concat(meta.outNames || [], meta.outName ? [meta.outName] : [])
          .map((n) => String(n || '').toLowerCase());
        if (names.length && Array.isArray(files)) {
          for (const f of files) {
            const fn = String(f?.name || '').toLowerCase();
            if (names.some((n) => n && fn === n)) {
              clearComicProgress(ch.id, f.id);
            }
          }
        }
      } catch (_) {}
      // Asegurar que el canal (nuevo o no) está en LIB
      try {
        const id = String(ch.id);
        if (!LIB.some((c) => String(c.id) === id)) {
          LIB = [...LIB, ch];
          try { await kv.set('lib', LIB); } catch (_) {}
        } else {
          // Actualizar group/name por si cambió
          LIB = LIB.map((c) => (String(c.id) === id ? { ...c, ...ch } : c));
          try { await kv.set('lib', LIB); } catch (_) {}
        }
      } catch (_) {}
      try {
        const top = stack[stack.length - 1];
        if (!top) return;
        const ctx = top._uploadCtx || {};
        const chId = String(ch.id);
        const chGroup = String(ch.group || '');
        const sameChannel =
          (ctx.channel && String(ctx.channel.id) === chId)
          || String(top._chId || '') === chId;
        // Vista de canales de una editorial (sin canal/serie abiertos)
        const sameEditorial =
          ctx.editorial
          && !ctx.channel
          && (
            chGroup === String(ctx.editorial)
            || (typeof groupDisplayName === 'function'
              && groupDisplayName(chGroup) === String(ctx.editorial))
            || String(ctx.editorial).toLowerCase() === chGroup.toLowerCase()
          );
        // Home
        const onHome = stack.length === 1;
        // Serie/canal de la misma editorial: también refrescar si el listado podría cambiar
        const editorialContext =
          ctx.editorial
          && (
            chGroup === String(ctx.editorial)
            || String(ctx.editorial).toLowerCase() === chGroup.toLowerCase()
          );

        if (sameChannel || sameEditorial || onHome || editorialContext) {
          // Guardar scroll aproximado y repintar
          try {
            top.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
          } catch (_) {}
          show();
        }
      } catch (e) {
        console.warn('[upload] onUploadDone refresh', e);
      }
    },
  });
} catch (e) {
  console.error('[upload] createUploadTool falló', e);
}


const proTools = createProTools({
  el,
  kv,
  pref,
  setPref,
  devPref,
  setDevPref,
  applyGridLayoutPref,
  get LIB() { return LIB; },
  getCover,
  groupSeries,
  seriesOverrideFor,
  groupDisplayName,
  channelDisplayName,
  seriesDisplayName,
  comicSourceName,
  appConfirm,
  appAlert,
  closeAppMenu,
  onCoversChanged: () => {
    try {
      const top = stack[stack.length - 1];
      if (top) top.scrollY = window.scrollY || 0;
      show();
    } catch (_) {}
  },
  copyInfoFrameText,
  clearAllReadingData,
  getPagesTotal,
  setPagesTotal,
  getMsg,
  openPages,
  invalidateComicLocal,
});

// ---------- Inicio ----------
async function migrateCacheImages() {
  // Evitar correr en cada carga de la misma sesión de pestaña
  if (sessionStorage.getItem('cacheOptDone') === '1') return;
  try {
    const entries = await kv.entries();
    let n = 0;
    for (const [k, v] of entries) {
      if (typeof k !== 'string') continue;
      try {
        if (k.startsWith('c:') && v instanceof Blob && v.type !== 'image/webp') {
          const out = await optimizeImageBlob(v, 280, 0.72);
          if (out && out.size < v.size) {
            await kv.set(k, out);
            n++;
          }
        } else if (k.startsWith('art:') && v && v.blob instanceof Blob && !v.optimized) {
          const out = await optimizeImageBlob(v.blob, 384, 0.75);
          if (out) {
            await kv.set(k, { ...v, blob: out, optimized: true });
            n++;
          }
        }
      } catch (_) {}
      // Ceder el hilo cada pocas imágenes
      if (n && n % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    sessionStorage.setItem('cacheOptDone', '1');
    if (n) console.info('[caché] optimizadas', n, 'imágenes');
  } catch (e) {
    console.warn('[caché] migración', e);
  }
}

(async () => {
  if (!apiId || !apiHash) return msg('Faltan VITE_API_ID y VITE_API_HASH.');
  // Sync antes de biblioteca / seguir leyendo
  try { await sync.syncOnStartup(); } catch (_) {}
  try { applyCoverSizePrefs(); } catch (_) {} // por si la sincronización tocó algo: los tamaños son locales
  LIB = (await kv.get('lib')) || [];
  // Migrar progreso legado page:msg → page:ch:msg solo para cómics conocidos; borra legados sueltos
  try {
    if (sessionStorage.getItem('progMigV2') !== '1') {
      const filesByCh = {};
      for (const ch of LIB) {
        try { filesByCh[String(ch.id)] = (await kv.get('f:' + ch.id)) || []; } catch (_) { filesByCh[String(ch.id)] = []; }
      }
      migrateLegacyProgress(LIB, (id) => filesByCh[String(id)] || []);
      sessionStorage.setItem('progMigV2', '1');
    }
  } catch (_) {}
  try { initBalance(document.querySelector('#app')); } catch (_) {}
  stack.push({ title: 'Cómics', render: groupsView });
  show();
  // Optimizar caché antigua en segundo plano (WebP + menos resolución)
  migrateCacheImages();
  ready = connect();
  ready.catch((e) => msg('Error de conexión: ' + e.message));
  ready.then(refreshLibrary).then((lib) => {
    const changed = JSON.stringify(lib) !== JSON.stringify(LIB);
    LIB = lib; synced = true;
    if ((changed || !lib.length) && stack.length === 1) show();
  }).catch((e) => console.error(e));
})();
