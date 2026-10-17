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
  stripExt, clean, parseComicName, issueDisplay, comicDisplay,
  seriesBase, groupSeries, issueLabel, parseComicCaption, buildComicCaption,
} from './parse.js';
import {
  getPageIndex, setPageIndex, getPagesTotal, setPagesTotal,
  getPageFormat, setPageFormat, detectPageFormats,
  isComicRead, readProgress, markComicRead, markComicUnread,
  markSeriesRead, markSeriesUnread,
  getLastRead, setLastRead, getRecentReads, getContinueList, listUnfinishedProgress,
} from './progress.js';
import {
  ungroupMap, setUngroupMode,
  seriesDisplayName, setSeriesDisplayName,
  comicDisplayName, setComicDisplayName,
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
import { exportLibraryData, importLibraryData, downloadJson } from './dataPort.js';
import {
  comicVineConfigured, searchIssues, searchIssuesSmart, fetchIssueDetail, buildSearchQuery,
} from './comicvine.js';
import * as locks from './lock.js';

const apiId = Number(import.meta.env.VITE_API_ID);
const apiHash = import.meta.env.VITE_API_HASH;
zip.configure({ useWebWorkers: false });

// ---------- Utilidades ----------
const SEP = '::', TSEP = ':', POST = SEP + 'tgstorage', LIBRARY = 'comics', MB = 1024 * 1024;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const pref = (k, d) => localStorage.getItem('pref:' + k) || d;
const setPref = (k, v) => { localStorage.setItem('pref:' + k, v); try { sync.schedulePush(); } catch (_) {} };
/** Evita el zoom atascado de iOS al girar el dispositivo */
function resetMobileViewport() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const base = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  meta.setAttribute('content', base.replace('maximum-scale=1', 'maximum-scale=1.01'));
  requestAnimationFrame(() => {
    meta.setAttribute('content', base);
    window.scrollTo(0, 0);
    try { document.body.scrollTop = 0; document.documentElement.scrollTop = 0; } catch (_) {}
  });
}
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** Bloquea el scroll de la webapp detrás de Información / formularios (Android). */
function lockAppScroll() {
  if (document.body.classList.contains('body-scroll-lock')) return;
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.dataset.lockY = String(y);
  document.body.classList.add('body-scroll-lock');
  document.documentElement.classList.add('body-scroll-lock');
  document.body.style.position = 'fixed';
  document.body.style.top = `-${y}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
}
function unlockAppScroll() {
  if (document.querySelector('.info-frame, .sheet')) return;
  const y = Math.max(0, +(document.body.dataset.lockY || 0) || 0);
  document.body.classList.remove('body-scroll-lock');
  document.documentElement.classList.remove('body-scroll-lock');
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  delete document.body.dataset.lockY;
  try { window.scrollTo(0, y); } catch (_) {}
}
try {
  const _scrollLockMo = new MutationObserver(() => {
    if (document.querySelector('.info-frame, .sheet')) lockAppScroll();
    else unlockAppScroll();
  });
  _scrollLockMo.observe(document.body, { childList: true });
} catch (_) {}
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
    phoneNumber: async () => prompt('Teléfono con prefijo (+34...)'),
    phoneCode: async () => prompt('Código recibido en Telegram'),
    password: async () => prompt('Contraseña de verificación en dos pasos'),
    onError: (e) => alert(e.message),
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

async function fetchFiles(ch) {
  await ready;
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
  await kv.set('f:' + ch.id, out);
  return out;
}

const msgs = new Map();
async function getMsg(ch, f) {
  const k = ch.id + ':' + f.id;
  if (!msgs.has(k)) { await ready; msgs.set(k, client.getMessages(peerOf(ch), { ids: [f.id] }).then((r) => r[0])); }
  return msgs.get(k);
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
  }
);
const { getCover, saveCoverBlob, optimizeImageBlob, comicCover, pump, io } = coverApi;

// ---------- Navegación y vistas ----------
const app = $('#app'), titleEl = $('#title'), backBtn = $('#back'), actions = $('#actions');
const stack = [];
function modeBtn(after) {
  const b = el('button', 'btn mode');
  // Muestra el modo AL QUE se cambia
  const nextOf = { page: 'vertical', vertical: 'horizontal', horizontal: 'page' };
  const labelOf = { page: '☰ Vertical', vertical: '⇔ Horizontal', horizontal: '▯ Página' };
  b._label = () => {
    let cur = pref('mode', 'page');
    if (!nextOf[cur]) cur = 'page';
    b.textContent = labelOf[cur];
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
menuPanel.append(menuInfoBtn, menuCfgBtn, menuSyncBtn, menuUploadBtn, menuRepackBtn, menuUnreadBtn, menuLockBtn);
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
            alert('No se pudo copiar');
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
        alert('Exportación: ' + (e?.message || e));
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
        alert(`Importado: ${r.localStorage} claves, ${r.covers} portadas. Recarga la página.`);
      } catch (e) {
        alert('Importación: ' + (e?.message || e));
      }
      impInput.value = '';
    };
    const btnClrPc = el('button', 'btn', 'Vaciar caché páginas');
    btnClrPc.type = 'button';
    btnClrPc.onclick = async () => {
      if (!confirm('¿Borrar todas las páginas en caché de lectura?')) return;
      await pageCache.clearAll();
      alert('Caché de páginas vaciada');
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
  const toggleGroup = (options, getVal, setVal) => {
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
      };
      btns.push({ b, val });
      wrap.append(b);
    }
    body.append(wrap);
    paint();
    return paint;
  };

  section('Visualización páginas');
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
    (v) => setPref('mode', v)
  );

  section('Ajuste Páginas');
  toggleGroup(
    [
      ['width', 'Modo Ancho'],
      ['screen', 'Modo Pantalla'],
    ],
    () => (pref('fit', 'screen') === 'width' ? 'width' : 'screen'),
    (v) => setPref('fit', v)
  );

  section('Caché de páginas (lectura)');
  const pcWrap = el('div', 'cfg-group');
  const pcLab = el('p', 'sync-status', 'Máximo de caché de páginas (MB)');
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
  const pcHint = el('p', 'cover-pick-hint', 'Por defecto 500 MB. Las páginas vistas se guardan para no re-descargarlas.');
  pcWrap.append(pcLab, pcInp, pcHint);
  body.append(pcWrap);

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
}
menuCfgBtn.onclick = (ev) => { ev.stopPropagation(); showViewerConfig(); };
menuLockBtn.onclick = async (ev) => {
  ev.stopPropagation();
  closeAppMenu();
  if (!locks.canUseLocks()) {
    alert('Inicia sesión de sincronización para usar el candado de contenido.');
    return;
  }
  if (locks.isSessionUnlocked()) {
    locks.lockSession();
    paintLockMenu();
    try { groupsView(); } catch (_) {}
    return;
  }
  const pw = prompt('Contraseña de sincronización para desbloquear contenido:');
  if (pw == null) return;
  const ok = await locks.unlockSession(pw);
  if (!ok) {
    alert('Contraseña incorrecta');
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
        alert('La herramienta de subida no está disponible. Recarga la página.');
        return;
      }
      uploadTool.showUploadFrame(getUploadContext());
    } catch (e) {
      console.error('[upload] showUploadFrame', e);
      alert('Error al abrir subida: ' + (e?.message || e));
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
function show() {
  cleanup?.(); cleanup = null;
  const e = stack[stack.length - 1];
  titleEl.textContent = e.title;
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
  e.render(e);
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
let lastScrollY = 0, headerHidden = false;
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

// Gesto atrás (borde izquierdo → derecha) al navegar series/canales/editoriales
(() => {
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
const artNorm = (s) => s.normalize('NFC').trim().toLowerCase();
const artLoose = (s) => artNorm(String(s || '').replace(/[\s_\-]+/g, ''));
const reg = (kind, files) => {
  for (const [p, url] of Object.entries(files)) {
    const base = decodeURIComponent(p.split('/').pop()).replace(/\.\w+$/i, '').trim();
    ART[kind][artNorm(base)] = url;
    ART[kind][base.normalize('NFD').trim().toLowerCase()] = url;
    // Sin espacios: WildStorm / Wild Storm / Wildstorm → misma clave
    ART[kind][artLoose(base)] = url;
  }
};
reg('groups', import.meta.glob(['/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}', '/src/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}'], { eager: true, query: '?url', import: 'default' }));
reg('channels', import.meta.glob(['/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}', '/src/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}'], { eager: true, query: '?url', import: 'default' }));
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
  const d = el('div', kind === 'groups' ? 'cover square' : 'cover');
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
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      ltr.remove();
      d.querySelector('img')?.remove();
      d.append(img);
    };
    img.src = url;
  };

  const tryCandidates = async (skipUrl) => {
    for (const url of candidates) {
      if (skipUrl && url === skipUrl) continue;
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob.size) continue;
        const opt = await optimizeImageBlob(blob, 384, 0.75);
        const meta = {
          blob: opt || blob,
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
        const opt = await optimizeImageBlob(fresh.blob, 384, 0.75);
        fresh.blob = opt || fresh.blob;
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
function bindLongPress(node, fn, ms = 480) {
  if (!fn || !node) return;
  // Evitar doble menú en Android (touchend + contextmenu)
  if (node.dataset.lpBound === '1') return;
  node.dataset.lpBound = '1';
  let timer = null, sx = 0, sy = 0, armed = false, opened = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const openOnce = (e) => {
    if (opened) return;
    opened = true;
    try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch (_) {}
    setTimeout(() => { try { fn(e); } catch (_) {} }, 10);
  };
  const onStart = (e) => {
    const pt = e.touches ? e.touches[0] : e;
    sx = pt.clientX; sy = pt.clientY;
    armed = false;
    opened = false;
    clear();
    timer = setTimeout(() => {
      armed = true;
      try { navigator.vibrate?.(12); } catch (_) {}
      node.classList.add('long-press');
    }, ms);
  };
  const onMove = (e) => {
    const pt = e.touches ? e.touches[0] : e;
    if (Math.abs(pt.clientX - sx) > 12 || Math.abs(pt.clientY - sy) > 12) {
      clear();
      armed = false;
      node.classList.remove('long-press');
    }
  };
  const onEnd = (e) => {
    clear();
    node.classList.remove('long-press');
    if (armed) openOnce(e);
  };
  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchmove', onMove, { passive: true });
  node.addEventListener('touchend', onEnd, { passive: false });
  node.addEventListener('touchcancel', () => {
    clear();
    armed = false;
    node.classList.remove('long-press');
  }, { passive: true });
  // Escritorio: clic derecho (y algunos Android que disparan contextmenu)
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openOnce(e);
  }, true);
  node.addEventListener('click', (e) => {
    if (opened || armed) {
      e.preventDefault();
      e.stopPropagation();
      opened = false;
      armed = false;
    }
  }, true);
}

function formatPeople(s) {
  const parts = String(s || '')
    .split(/\s*\|\s*|\s*;\s*|\s*,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : (s || '—');
}

function copyInfoFrameText(bodyEl, label) {
  try {
    const lines = [];
    for (const node of bodyEl.querySelectorAll('.info-sec, .info-row')) {
      if (node.classList.contains('info-sec')) {
        lines.push('', node.textContent.trim());
      } else if (node.classList.contains('info-row')) {
        const lab = node.querySelector('.info-label')?.textContent?.trim() || '';
        const val = node.querySelector('.info-value')?.textContent?.trim() || '';
        lines.push(lab ? (lab + ': ' + val) : val);
      }
    }
    const text = lines.join('\n').replace(/^\n+/, '').trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      // feedback breve en el head
    }).catch(() => {
      prompt('Copiar:', text);
    });
  } catch (e) {
    console.warn('copy info', e);
  }
}

function showDescriptionPanel(text) {
  document.querySelector('.info-frame.desc-panel')?.remove();
  const frame = el('div', 'info-frame desc-panel');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Descripción'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  const p = el('div', 'desc-panel-text');
  p.textContent = String(text || '');
  body.append(p);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
}

function showComicInfo(ch, f, displayTitle) {
  try {
    document.querySelector('.info-frame.comic-info')?.remove();
    const cap = parseComicCaption(f?.caption || '');
    const parsed = parseComicName(f?.name || '', ch?.name);
    // Serie = override de agrupación o la del nombre de archivo
    let seriesKey = (ch && f ? getComicSeriesOverride(ch, f) : null)
      || parsed?.series || seriesBase(f?.name || '', ch?.name) || '';
    seriesKey = String(seriesKey || '').trim();
    let series = seriesKey || '—';
    // Título: con serie → solo "#nn - info" (como bajo la portada en la serie).
    // Se parte del caption (Título España) o del nombre de archivo, nunca "Serie #nn".
    const issueFromFile = parsed ? issueDisplay(parsed) : '';
    let title = '—';
    if (ch && f) {
      if (seriesKey) {
        // Forzar contexto "serie" con fallback que empieza por #
        const fb = issueFromFile || '#';
        title = comicDisplayName(ch, f, fb.startsWith('#') ? fb : ('#' + fb)) || fb;
        // Por si quedó "Badlands #007"
        if (title && !/^#/.test(title.trim())) {
          const mh = title.match(/#\s*(.+)$/);
          title = mh ? ('#' + mh[1].replace(/^#\s*/, '').trim()) : (issueFromFile || title);
        }
      } else {
        title = comicDisplayName(ch, f, comicDisplay(f.name, ch.name) || clean(f.name))
          || comicDisplay(f.name, ch.name)
          || '—';
      }
    } else if (displayTitle) {
      title = String(displayTitle).trim();
    }
    const fname = f?.name || '';
    const fmt = /\.cbz$/i.test(fname) ? 'CBZ (ZIP)' : /\.cbr$/i.test(fname) ? 'CBR (RAR)' : '—';
    const pages = (ch && f) ? getPagesTotal(ch.id, f.id) : 0;
    const pagesLabel = pages > 0 ? String(pages) : '— (se conoce al abrir)';
    let pageFmt = '— (se detecta al abrir)';
    try {
      const storedFmt = (ch && f) ? getPageFormat(ch.id, f.id) : '';
      if (storedFmt) pageFmt = storedFmt;
      else if (pages > 0) pageFmt = '—';
    } catch (_) {}

    const frame = el('div', 'info-frame comic-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    const titleSpan = el('span', 'info-head-title', 'Información');
    titleSpan.title = 'Pulsa para copiar';
    head.append(titleSpan);
    const close = el('button', 'btn info-close', '×');
    close.setAttribute('aria-label', 'Cerrar');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    titleSpan.onclick = (ev) => {
      ev.stopPropagation();
      copyInfoFrameText(body);
      titleSpan.textContent = 'Copiado';
      setTimeout(() => { titleSpan.textContent = 'Información'; }, 1200);
    };
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Archivo'));
    body.append(row('Título', title));
    body.append(row('Serie', series));
    body.append(row('Canal', ch ? channelDisplayName(ch) : '—'));
    body.append(row('Editorial canal', ch?.group || '—'));
    body.append(row('Archivo', fname || '—'));
    body.append(row('Formato', fmt));
    body.append(row('Tamaño', formatBytes(f?.size)));
    body.append(row('Páginas', pagesLabel));
    body.append(row('Formato pág.', pageFmt));
    const hasFicha = !!(cap.fileName || cap.titleEs || cap.originalTitle || cap.series || cap.writer || cap.artist || cap.publisher || cap.date || cap.description);
    body.append(el('div', 'info-sec', 'Ficha en Telegram'));
    if (hasFicha) {
      if (cap.fileName) body.append(row('Nombre de archivo', cap.fileName));
      if (cap.titleEs) body.append(row('Título España', cap.titleEs));
      if (cap.originalTitle) body.append(row('Título original', cap.originalTitle));
      if (cap.series) body.append(row('Serie', cap.series));
      if (cap.writer) body.append(row('Guionista', formatPeople(cap.writer)));
      if (cap.artist) body.append(row('Dibujante', formatPeople(cap.artist)));
      if (cap.publisher) body.append(row('Editorial', cap.publisher));
      if (cap.date) body.append(row('Fecha de publicación', cap.date));
      if (cap.description) {
        const descBtn = el('button', 'btn info-desc-btn', 'Ver descripción');
        descBtn.type = 'button';
        descBtn.onclick = () => {
          frame.remove();
          showDescriptionPanel(cap.description);
        };
        body.append(descBtn);
      }
    } else if (f?.caption && String(f.caption).trim()) {
      body.append(el('p', 'cover-pick-hint', String(f.caption).slice(0, 800)));
      const fillBtn = el('button', 'btn cover-pick-device', 'Rellenar Ficha Telegram');
      fillBtn.type = 'button';
      fillBtn.onclick = () => {
        frame.remove();
        showCaptionEditor(ch, f, () => showComicInfo(ch, f, displayTitle));
      };
      body.append(fillBtn);
    } else {
      body.append(el('p', 'cover-pick-hint', 'Sin datos en Telegram'));
      const fillBtn = el('button', 'btn cover-pick-device', 'Rellenar Ficha Telegram');
      fillBtn.type = 'button';
      fillBtn.onclick = () => {
        frame.remove();
        showCaptionEditor(ch, f, () => showComicInfo(ch, f, displayTitle));
      };
      body.append(fillBtn);
    }
    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error('showComicInfo', err);
    alert('No se pudo mostrar la información: ' + (err?.message || err));
  }
}


function grid(items, withSearch, searchPlaceholder) {
  const g = el('div', 'grid'), nodes = [];
  const matchItem = (i, q) => {
    if (!q) return true;
    if ((i.label || '').toLowerCase().includes(q)) return true;
    if (i.searchText && i.searchText.includes(q)) return true;
    return false;
  };
  const draw = (q = '') => {
    let list = items.filter((i) => matchItem(i, q));
    if (pref('showUnreadOnly', '0') === '1') {
      list = list.filter((i) => i.isUnread !== false);
    }
    g.replaceChildren(...list.map((i) => {
    const c = el('div', 'card'), hit = el('button', 'hit'), name = el('div', 'name'), t = el('b', '', i.label);
    hit.append(i.cover());
    hit.onclick = i.go;
    if (i.longPress) bindLongPress(hit, i.longPress);
    if (i.menu) {
      t.classList.add('has-menu');
      t.onclick = (ev) => { ev.stopPropagation(); i.menu(); };
      t.title = 'Opciones';
      t.setAttribute('role', 'button');
      t.setAttribute('aria-label', 'Opciones de ' + i.label);
    } else {
      t.onclick = i.go;
    }
    if (i.longPress) bindLongPress(t, i.longPress);
    name.append(t);
    c.append(hit, name);
    if (i.sub) c.append(el('small', '', i.sub));
    return c;
  }));
  };
  if (withSearch) {
    const wrap = el('div', 'search-wrap');
    const s = el('input');
    s.id = 'search';
    s.type = 'search';
    s.placeholder = searchPlaceholder || 'Buscar…';
    const clear = el('button', 'search-clear', '×');
    clear.type = 'button';
    clear.hidden = true;
    clear.setAttribute('aria-label', 'Limpiar búsqueda');
    clear.onclick = () => { s.value = ''; clear.hidden = true; draw(''); s.focus(); };
    s.oninput = () => {
      const q = s.value.toLowerCase().trim();
      clear.hidden = !s.value;
      draw(q);
    };
    wrap.append(s, clear);
    nodes.push(wrap);
  }
  nodes.push(g);
  app.replaceChildren(...nodes);
  draw();
  // No forzar scroll a 0: show()/go() restauran la posición al volver del lector
}
function sheet(title, opts) {
  // Un solo menú a la vez (Android a veces abre dos)
  document.querySelectorAll('.sheet').forEach((s) => s.remove());
  const bg = el('div', 'sheet'), box = el('div', 'box'), close = () => bg.remove();
  box.append(el('div', 'sh-title', title));
  for (const [label, fn] of opts) { const b = el('button', 'btn', label); b.onclick = () => { close(); fn(); }; box.append(b); }
  const c = el('button', 'btn', 'Cancelar'); c.onclick = close;
  box.append(c);
  bg.onclick = (ev) => { if (ev.target === bg) close(); };
  bg.append(box);
  document.body.append(bg);
}
function existingSeriesLabels(ch, files) {
  const labels = new Set();
  for (const { label } of groupSeries(files || [], ch.name, seriesOverrideFor(ch))) {
    if (label) labels.add(label);
  }
  // Incluir overrides ya guardados
  try {
    const m = JSON.parse(localStorage.getItem('comicSeries:' + ch.id) || '{}');
    for (const v of Object.values(m || {})) if (v) labels.add(String(v));
  } catch (_) {}
  return [...labels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Editar título y serie del cómic (agrupa en la serie si existe) */

async function updateTelegramCaption(ch, f, caption) {
  if (!ch || !f?.id) return;
  await ready;
  if (!client) throw new Error('Cliente Telegram no listo');
  const peer = peerOf(ch);
  await client.invoke(new Api.messages.EditMessage({
    peer,
    id: Number(f.id),
    message: String(caption || ''),
  }));
  try {
    const files = (await kv.get('f:' + ch.id)) || [];
    const i = files.findIndex((x) => String(x.id) === String(f.id));
    if (i >= 0) {
      files[i] = { ...files[i], caption: String(caption || '') };
      await kv.set('f:' + ch.id, files);
    }
  } catch (_) {}
  f.caption = String(caption || '');
}


/** Formulario completo de ficha Telegram + Identificar (Comic Vine) */
function showCaptionEditor(ch, f, after, opts = {}) {
  document.querySelector('.info-frame.caption-editor')?.remove();
  const cap = parseComicCaption(f?.caption || '');
  const parsed = parseComicName(f?.name || '', ch?.name);
  const frame = el('div', 'info-frame caption-editor');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Ficha Telegram'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');

  const idBtn = el('button', 'btn-identify', 'Identificar');
  idBtn.type = 'button';
  body.append(idBtn);
  body.append(el('p', 'cover-pick-hint', 'Busca en Comic Vine y rellena los campos. Necesitas VITE_COMICVINE_API_KEY.'));

  // Tras identificar: elegir qué campos de CV aplicar
  const selBar = el('div', 'meta-sel-bar');
  selBar.hidden = true;
  const btnAll = el('button', 'btn', 'Seleccionar todos');
  btnAll.type = 'button';
  const btnNone = el('button', 'btn', 'Ninguno');
  btnNone.type = 'button';
  selBar.append(btnAll, btnNone);
  body.append(selBar);
  body.append(el('p', 'cover-pick-hint meta-sel-hint', 'Marcado = dato de Comic Vine (editable). Sin marcar = valor anterior.'));
  const selHint = body.lastChild;
  selHint.hidden = true;

  const fieldCtrls = [];

  const mkField = (lab, prevVal, ph, multiline) => {
    const wrap = el('div', 'meta-field');
    const top = el('label', 'meta-field-top');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.className = 'meta-field-chk';
    chk.hidden = true;
    chk.checked = false;
    top.append(chk, document.createTextNode(' ' + lab));
    wrap.append(top);
    let inp;
    if (multiline) {
      inp = el('textarea', 'edit-input meta-desc meta-desc-lg');
      inp.rows = 14;
    } else {
      inp = el('input', 'edit-input');
      inp.type = 'text';
      inp.autocomplete = 'off';
    }
    const prev = prevVal != null ? String(prevVal) : '';
    inp.value = prev;
    if (ph) inp.placeholder = ph;
    wrap.append(inp);
    body.append(wrap);

    const ctrl = {
      chk, inp,
      prev,
      cv: '',
      apply() {
        if (chk.hidden) return;
        inp.value = chk.checked ? (ctrl.cv || '') : ctrl.prev;
      },
    };
    chk.onchange = () => ctrl.apply();
    fieldCtrls.push(ctrl);
    return ctrl;
  };

  const fileNameCtrl = mkField('Nombre de archivo', cap.fileName || (f?.name || ''));
  const titleEsCtrl = mkField('Título España', cap.titleEs);
  const origCtrl = mkField('Título original', cap.originalTitle);
  const seriesCtrl = mkField('Serie', cap.series || parsed?.series || '');
  const writerCtrl = mkField('Guionista', cap.writer, 'Nombre1 | Nombre2');
  const artistCtrl = mkField('Dibujante', cap.artist, 'Nombre1 | Nombre2');
  const pubCtrl = mkField('Editorial', cap.publisher);
  const dateCtrl = mkField('Fecha de publicación', cap.date, 'MM/AAAA o AAAA');
  const descCtrl = mkField('Descripción', cap.description || '', '', true);

  const setSelectMode = (on) => {
    selBar.hidden = !on;
    selHint.hidden = !on;
    for (const c of fieldCtrls) {
      c.chk.hidden = !on;
      if (!on) c.chk.checked = false;
    }
  };

  btnAll.onclick = () => {
    for (const c of fieldCtrls) {
      c.chk.checked = true;
      c.apply();
    }
  };
  btnNone.onclick = () => {
    for (const c of fieldCtrls) {
      c.chk.checked = false;
      c.apply();
    }
  };

  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar en Telegram');
  save.onclick = async () => {
    // Guardar lo que hay en los inputs (según checks ya aplicados)
    const caption = buildComicCaption({
      fileName: fileNameCtrl.inp.value,
      titleEs: titleEsCtrl.inp.value,
      originalTitle: origCtrl.inp.value,
      series: seriesCtrl.inp.value,
      writer: writerCtrl.inp.value,
      artist: artistCtrl.inp.value,
      publisher: pubCtrl.inp.value,
      date: dateCtrl.inp.value,
      description: descCtrl.inp.value,
    });
    if (caption.length > 1024) {
      alert('El caption tiene ' + caption.length + ' caracteres (máx. 1024). Acorta la descripción.');
      return;
    }
    try {
      save.disabled = true;
      await updateTelegramCaption(ch, f, caption);
      frame.remove();
      const editWasOpen = !!document.querySelector('.info-frame.edit-comic');
      document.querySelector('.info-frame.edit-comic')?.remove();
      document.querySelector('.info-frame.comic-info')?.remove();
      try { after?.(); } catch (_) {}
      try {
        const top = stack[stack.length - 1];
        if (top && !top._isComic && !document.getElementById('rd')) {
          top.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
          show();
        }
      } catch (_) {}
      if (editWasOpen || opts.reopenEdit) {
        showEditComicTitle(ch, f, opts.currentLabel || '', after);
      }
    } catch (e) {
      alert('No se pudo guardar el caption: ' + (e?.message || e));
    } finally {
      save.disabled = false;
    }
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);

  idBtn.onclick = () => showComicVinePicker(ch, f, {
    onPick: (detail) => {
      if (!detail) return;
      const num = String(detail.issueNumber || '').replace(/^#/, '').trim();
      const story = String(detail.name || '').trim();
      let titleLine = '';
      if (num && story) titleLine = '#' + num + ' - ' + story;
      else if (num) titleLine = '#' + num;
      else titleLine = story;

      // Valores CV por campo (nombre de archivo no viene de CV → dejar vacío = no forzar)
      titleEsCtrl.cv = titleLine;
      origCtrl.cv = titleLine;
      seriesCtrl.cv = detail.volume || '';
      writerCtrl.cv = (detail.writers && detail.writers.length) ? detail.writers.join(' | ') : '';
      artistCtrl.cv = (detail.artists && detail.artists.length) ? detail.artists.join(' | ') : '';
      pubCtrl.cv = detail.publisher || '';
      dateCtrl.cv = detail.coverDate || '';
      descCtrl.cv = detail.description || '';
      fileNameCtrl.cv = fileNameCtrl.prev; // no cambia por CV

      setSelectMode(true);
      // Por defecto: marcar los que CV aportó dato
      for (const c of fieldCtrls) {
        const hasCv = c === fileNameCtrl ? false : !!(c.cv && String(c.cv).trim());
        c.chk.checked = hasCv;
        c.apply();
      }
    },
  });
}

function showComicVinePicker(ch, f, { onPick } = {}) {
  document.querySelector('.info-frame.cv-picker')?.remove();
  const frame = el('div', 'info-frame cv-picker');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Identificar (Comic Vine)'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');

  const ourPages = (ch && f) ? getPagesTotal(ch.id, f.id) : 0;
  const pagesInfo = el('p', 'cv-our-pages',
    ourPages > 0
      ? ('Páginas de tu archivo: ' + ourPages)
      : 'Páginas de tu archivo: desconocido (ábrelo una vez en el lector para contarlas)'
  );
  body.append(pagesInfo);

  const parsed = parseComicName(f?.name || '', ch?.name);
  const cap = parseComicCaption(f?.caption || '');
  const qDefault = buildSearchQuery({
    channel: ch?.name || '',
    series: cap.series || parsed?.series || seriesBase(f?.name || '', ch?.name) || '',
    number: parsed?.number || '',
    fileName: f?.name || '',
  });

  body.append(el('label', 'sync-label', 'Búsqueda'));
  const qInp = el('input', 'edit-input');
  qInp.type = 'text';
  qInp.value = qDefault;
  body.append(qInp);
  const searchBtn = el('button', 'btn edit-save', 'Buscar');
  searchBtn.type = 'button';
  body.append(searchBtn);
  const status = el('p', 'sync-status', '');
  body.append(status);
  const list = el('div', 'cv-results');
  body.append(list);

  const runSearch = async () => {
    list.replaceChildren();
    if (!comicVineConfigured()) {
      status.textContent = 'Configura VITE_COMICVINE_API_KEY en Vercel (.env).';
      status.className = 'sync-status sync-err';
      return;
    }
    const q = qInp.value.trim();
    if (!q) {
      status.textContent = 'Escribe algo para buscar';
      return;
    }
    searchBtn.disabled = true;
    status.className = 'sync-status';
    status.textContent = 'Buscando en Comic Vine…';
    try {
      const seriesQ = (cap.series || parsed?.series || seriesBase(f?.name || '', ch?.name) || '').trim();
      const numberQ = String(parsed?.number || '').replace(/^#/, '').trim();
      const results = await searchIssuesSmart({
        query: q,
        series: seriesQ,
        number: numberQ,
      });
      status.textContent = results.length
        ? (results.length + ' resultados (búsqueda ampliada)')
        : 'Sin resultados — prueba a quitar el canal o el número en la caja de texto';
      for (const r of results) {
        const btn = el('button', 'cv-result');
        btn.type = 'button';
        const title = [r.volume, r.issueNumber ? ('#' + r.issueNumber) : '', r.name].filter(Boolean).join(' ');
        btn.append(el('b', '', title || ('Issue ' + r.id)));
        const sub = [];
        if (r.coverDate) sub.push(r.coverDate);
        if (r.volume) sub.push(r.volume);
        if (sub.length) btn.append(el('span', 'cv-sub', sub.join(' · ')));
        btn.append(el('span', 'cv-pages',
          r.publisher ? ('Editorial: ' + r.publisher) : 'Editorial: —'
        ));
        btn.onclick = async () => {
          btn.disabled = true;
          status.textContent = 'Cargando ficha…';
          try {
            let detail = null;
            if (r.apiDetailUrl) detail = await fetchIssueDetail(r.apiDetailUrl);
            else detail = await fetchIssueDetail(r.id);
            if (!detail) {
              detail = {
                name: r.name,
                issueNumber: r.issueNumber,
                volume: r.volume,
                coverDate: r.coverDate,
                publisher: r.publisher || '',
                writers: [],
                artists: [],
                description: '',
              };
            } else {
              // Preferir número/nombre del resultado de la lista si el detalle los trae vacíos
              if (!detail.issueNumber && r.issueNumber) detail.issueNumber = r.issueNumber;
              if (!detail.name && r.name) detail.name = r.name;
              if (!detail.volume && r.volume) detail.volume = r.volume;
              if (!detail.publisher && r.publisher) detail.publisher = r.publisher;
              // Si el detalle trae name vacío pero sí número, no dejar títulos distintos
              if (r.issueNumber && !detail.issueNumber) detail.issueNumber = r.issueNumber;
            }
            frame.remove();
            onPick?.(detail);
          } catch (e) {
            status.textContent = 'Error: ' + (e?.message || e);
            status.className = 'sync-status sync-err';
            btn.disabled = false;
          }
        };
        list.append(btn);
      }
    } catch (e) {
      status.textContent = 'Error: ' + (e?.message || e);
      status.className = 'sync-status sync-err';
    } finally {
      searchBtn.disabled = false;
    }
  };

  searchBtn.onclick = () => runSearch();
  qInp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); runSearch(); }
  });

  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
  // Auto-buscar si hay query
  if (qDefault) setTimeout(runSearch, 100);
}

function showEditComicTitle(ch, f, currentLabel, after) {
  document.querySelector('.info-frame.edit-comic')?.remove();
  const fallbackTitle = comicDisplay(f?.name || '', ch?.name) || clean(f?.name || '') || '';
  const currentTitle = comicDisplayName(ch, f, currentLabel || fallbackTitle);
  const parsed = parseComicName(f?.name || '', ch?.name);
  const parsedSeries = (parsed?.series || seriesBase(f?.name || '', ch?.name) || '').trim();
  const overrideRaw = getComicSeriesOverride(ch, f);
  // Clave real de agrupación
  const seriesKey = (overrideRaw != null && String(overrideRaw).trim())
    ? String(overrideRaw).trim()
    : parsedSeries;

  const frame = el('div', 'info-frame edit-comic');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar datos del comic'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');

  body.append(el('div', 'info-sec', 'Título'));
  const inputTitle = el('input', 'edit-input');
  inputTitle.type = 'text';
  inputTitle.value = currentTitle;
  inputTitle.autocomplete = 'off';
  inputTitle.placeholder = 'Título visible';
  body.append(inputTitle);
  body.append(el('p', 'cover-pick-hint', 'Vacío = restaurar el del nombre de archivo.'));

  body.append(el('div', 'info-sec', 'Serie'));
  const seriesSel = el('select', 'edit-input series-select');
  const seriesOther = el('input', 'edit-input');
  seriesOther.type = 'text';
  seriesOther.autocomplete = 'off';
  seriesOther.placeholder = 'Nombre de la nueva serie';
  seriesOther.hidden = true;
  body.append(seriesSel);
  body.append(seriesOther);
  body.append(el('p', 'cover-pick-hint', 'Elige una serie del canal o «Otra…». Vacío / original = sin forzar agrupación.'));

  // Rellenar desplegable
  (async () => {
    try {
      let files = (await kv.get('f:' + ch.id)) || [];
      if (!files.length) {
        try { files = await fetchFiles(ch); } catch (_) {}
      }
      const labels = existingSeriesLabels(ch, files);
      seriesSel.replaceChildren();

      const optOrig = el('option');
      optOrig.value = '';
      optOrig.textContent = parsedSeries
        ? ('Original del archivo: ' + parsedSeries)
        : 'Original del archivo (sin serie)';
      seriesSel.append(optOrig);

      const seen = new Set();
      if (parsedSeries) seen.add(parsedSeries.toLowerCase());

      for (const lab of labels) {
        const k = String(lab).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const o = el('option');
        o.value = lab;
        const shown = seriesDisplayName(ch, lab);
        o.textContent = (shown && shown !== lab) ? (shown + ' (' + lab + ')') : lab;
        seriesSel.append(o);
      }

      // Si la clave actual no está en la lista (serie forzada rara), añadirla
      if (seriesKey && !seen.has(seriesKey.toLowerCase())
          && seriesKey.toLowerCase() !== parsedSeries.toLowerCase()) {
        const o = el('option');
        o.value = seriesKey;
        o.textContent = seriesKey;
        seriesSel.append(o);
      }

      const optOther = el('option');
      optOther.value = '__other__';
      optOther.textContent = 'Otra…';
      seriesSel.append(optOther);

      // Selección inicial
      if (!overrideRaw) {
        seriesSel.value = '';
        seriesOther.hidden = true;
      } else if ([...seriesSel.options].some((o) => o.value === seriesKey)) {
        seriesSel.value = seriesKey;
        seriesOther.hidden = true;
      } else {
        seriesSel.value = '__other__';
        seriesOther.hidden = false;
        seriesOther.value = seriesKey;
      }
    } catch (e) {
      console.warn('[series select]', e);
      const o = el('option');
      o.value = '';
      o.textContent = 'Original';
      seriesSel.append(o);
    }
  })();

  seriesSel.onchange = () => {
    if (seriesSel.value === '__other__') {
      seriesOther.hidden = false;
      seriesOther.focus();
    } else {
      seriesOther.hidden = true;
      seriesOther.value = '';
    }
  };

  const fichaBtn = el('button', 'btn cover-pick-device', 'Ficha Telegram');
  fichaBtn.type = 'button';
  fichaBtn.onclick = () => {
    showCaptionEditor(ch, f, after, { reopenEdit: true, currentLabel: currentLabel || currentTitle });
  };
  body.append(fichaBtn);

  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = async () => {
    const titleV = inputTitle.value.trim();
    let titleSave = titleV;
    if (titleSave && ch.name) {
      try {
        const esc = ch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        titleSave = titleSave.replace(new RegExp('^' + esc + '\\s*-\\s*', 'i'), '').trim();
      } catch (_) {}
    }
    if (!titleSave || titleSave === fallbackTitle) titleSave = '';
    // No guardar como personalizado títulos auto (Serie #n / del caption)
    if (titleSave) {
      try {
        const p = parseComicName(f?.name || '', ch?.name);
        const auto = p ? ((p.series + ' ' + issueDisplay(p)).trim()) : '';
        const auto2 = comicDisplay(f?.name || '', ch?.name) || '';
        const cap = parseComicCaption(f?.caption || '');
        const te = (cap.titleEs || '').trim();
        if (titleSave === auto || titleSave === auto2 || (te && titleSave === te)) titleSave = '';
        if (p?.series && titleSave.toLowerCase() === (p.series + ' ' + issueDisplay(p)).toLowerCase()) titleSave = '';
      } catch (_) {}
    }

    // Serie desde el <select>
    let seriesSave = '';
    const sel = seriesSel.value;
    if (sel === '__other__') {
      const custom = seriesOther.value.trim();
      if (!custom) seriesSave = '';
      else if (parsedSeries && custom.toLowerCase() === parsedSeries.toLowerCase()) seriesSave = '';
      else seriesSave = custom;
    } else if (!sel) {
      seriesSave = ''; // original
    } else if (parsedSeries && sel.toLowerCase() === parsedSeries.toLowerCase()) {
      seriesSave = '';
    } else {
      seriesSave = sel;
    }

    setComicDisplayName(ch, f, titleSave, () => {
      setComicSeries(ch, f, seriesSave, () => {
        frame.remove();
        after?.();
      });
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
  setTimeout(() => { inputTitle.focus(); inputTitle.select(); }, 50);
}


function showSeriesInfo(ch, seriesLabel, files) {
  try {
    document.querySelector('.info-frame.series-info')?.remove();
    const display = seriesDisplayName(ch, seriesLabel);
    const n = files?.length || 0;
    let bytes = 0;
    for (const f of files || []) bytes += Number(f.size) || 0;
    const frame = el('div', 'info-frame series-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    const titleSpan = el('span', 'info-head-title', 'Información');
    titleSpan.title = 'Pulsa para copiar';
    head.append(titleSpan);
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    titleSpan.onclick = (ev) => {
      ev.stopPropagation();
      copyInfoFrameText(body);
      titleSpan.textContent = 'Copiado';
      setTimeout(() => { titleSpan.textContent = 'Información'; }, 1200);
    };
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Serie'));
    body.append(row('Nombre', display));
    if (display !== seriesLabel) body.append(row('Nombre original', seriesLabel));
    body.append(row('Canal', ch ? channelDisplayName(ch) : '—'));
    body.append(row('Editorial', ch?.group || '—'));
    body.append(row('Números', String(n)));
    body.append(row('Tamaño total', formatBytes(bytes)));
    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error(err);
    alert('No se pudo mostrar la información');
  }
}

/** Primera portada de cómic disponible (prueba varios si el 1º falla, p.ej. CBR sin abrir). */
async function firstAvailableCover(ch, files) {
  let list = Array.isArray(files) ? files : [];
  if (!list.length && ch?.id) {
    try {
      list = (await kv.get('f:' + ch.id)) || [];
    } catch (_) { list = []; }
  }
  if (!list.length && ch?.id) {
    try { list = await fetchFiles(ch); } catch (_) { list = []; }
  }
  for (const f of list) {
    if (!f?.id) continue;
    try {
      const b = await getCover(ch, f);
      if (b instanceof Blob && b.size) return b;
    } catch (_) {}
  }
  return null;
}

const seriesCoverKey = (ch, label) => `sc:${ch.id}:${String(label || '').toLowerCase()}`;
async function getSeriesCoverBlob(ch, seriesLabel, files) {
  try {
    const b = await kv.get(seriesCoverKey(ch, seriesLabel));
    if (b instanceof Blob && b.size) return b;
  } catch (_) {}
  return firstAvailableCover(ch, files);
}
async function setSeriesCoverBlob(ch, seriesLabel, blob) {
  if (!blob) return;
  try {
    const opt = await optimizeImageBlob(blob, 320, 0.75);
    await kv.set(seriesCoverKey(ch, seriesLabel), opt || blob);
  } catch (e) {
    console.warn('series cover', e);
    try { await kv.set(seriesCoverKey(ch, seriesLabel), blob); } catch (_) {}
  }
}
function seriesReadProgress(ch, files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  let done = 0;
  for (const f of list) {
    if (isComicRead(ch.id, f.id)) done++;
  }
  if (done === 0) return null;
  const pct = Math.round((done / list.length) * 100);
  return { done, tot: list.length, pct };
}

function seriesCoverNode(ch, seriesLabel, files, badge) {
  const d = el('div', 'cover'), ltr = el('span', '', (seriesDisplayName(ch, seriesLabel) || seriesLabel || '?').slice(0, 1).toUpperCase());
  d.append(ltr);
  if (badge != null && badge !== '') {
    d.append(el('span', 'badge series', String(badge)));
  }
  // Progreso de lectura de la serie (como en cómics)
  const sprog = seriesReadProgress(ch, files);
  if (sprog) {
    const bar = el('div', 'prog');
    const fill = el('div', 'prog-fill');
    fill.style.width = sprog.pct + '%';
    bar.append(fill);
    d.append(bar);
    const pb = el('span', 'prog-badge', sprog.pct >= 95 ? '✓' : sprog.pct + '%');
    d.append(pb);
  }
  d._load = async () => {
    const b = await getSeriesCoverBlob(ch, seriesLabel, files);
    if (!b) return;
    const img = new Image();
    img.onload = () => { ltr.remove(); d.prepend(img); };
    img.src = URL.createObjectURL(b);
  };
  io.observe(d);
  return d;
}
/** Submenú Editar serie */
function showEditSeries(ch, seriesLabel, files, after) {
  const title = seriesDisplayName(ch, seriesLabel);
  const list = Array.isArray(files) ? files : [];
  sheet(title, [
    ['Editar nombre de la serie a la que pertenece', () => showEditSeriesName(ch, seriesLabel, list, after)],
    ['Seleccionar portada de la serie', () => showSeriesCoverPicker(ch, seriesLabel, list, after)],
  ]);
}
function showEditSeriesName(ch, seriesLabel, seriesFiles, after) {
  document.querySelector('.info-frame.edit-series')?.remove();
  // Valor que ve el usuario: override real de los cómics o renombre visual o la clave
  const current = seriesDisplayName(ch, seriesLabel) || seriesLabel || '';
  const frame = el('div', 'info-frame edit-series');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar nombre de la serie'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', 'Nombre de la serie'));
  const input = el('input', 'edit-input');
  input.type = 'text';
  input.value = current;
  input.autocomplete = 'off';
  body.append(input);
  body.append(el('p', 'cover-pick-hint',
    'Se aplica a todos los cómics de esta serie. Si el nombre ya existe, se fusionan.'
  ));
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = async () => {
    const newName = input.value.trim();
    try {
      let allFiles = (await kv.get('f:' + ch.id)) || [];
      if (!allFiles.length) {
        try { allFiles = await fetchFiles(ch); } catch (_) {}
      }
      // Miembros de la serie (lista pasada o por clave/override)
      let members = Array.isArray(seriesFiles) && seriesFiles.length ? seriesFiles.slice() : [];
      if (!members.length) {
        for (const f of allFiles) {
          const ov = getComicSeriesOverride(ch, f);
          const p = parseComicName(f.name, ch.name);
          const base = (ov != null && String(ov).trim())
            ? String(ov).trim()
            : (p?.series || seriesBase(f.name, ch.name) || '');
          if (String(base).toLowerCase() === String(seriesLabel).toLowerCase()) members.push(f);
        }
      }
      if (!members.length) {
        alert('No se encontraron cómics de esta serie');
        return;
      }

      // ¿Fusionar con una serie ya existente (otra clave)?
      const labels = existingSeriesLabels(ch, allFiles);
      const hit = newName
        ? labels.find((lab) =>
            lab.toLowerCase() !== String(seriesLabel).toLowerCase()
            && lab.toLowerCase() === newName.toLowerCase()
          )
        : null;
      const target = hit || newName;

      // UN solo mecanismo: override por cómic (no renombre visual)
      for (const f of members) {
        const p = parseComicName(f.name, ch.name);
        const parsedSer = (p?.series || seriesBase(f.name, ch.name) || '').trim();
        if (!target || (parsedSer && target.toLowerCase() === parsedSer.toLowerCase())) {
          setComicSeries(ch, f, ''); // vuelve al nombre del archivo
        } else {
          setComicSeries(ch, f, target);
        }
      }
      // Limpiar renombres visuales viejos para no liar el campo
      try { setSeriesDisplayName(ch, seriesLabel, ''); } catch (_) {}
      if (target && target.toLowerCase() !== String(seriesLabel).toLowerCase()) {
        try { setSeriesDisplayName(ch, target, ''); } catch (_) {}
      }
    } catch (e) {
      console.error('[series rename]', e);
      alert('Error al guardar la serie: ' + (e?.message || e));
      return;
    }
    frame.remove();
    after?.();
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function showSeriesCoverPicker(ch, seriesLabel, files, after) {
  document.querySelector('.info-frame.cover-pick')?.remove();
  const title = seriesDisplayName(ch, seriesLabel);
  const frame = el('div', 'info-frame cover-pick');
  const box = el('div', 'info-box cover-pick-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Portada de la serie'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', title));
  body.append(el('p', 'cover-pick-hint', 'Elige la portada de un número de la serie o una imagen del dispositivo.'));

  const pickFile = el('button', 'btn cover-pick-device', '📁  Desde fotos o archivos');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  pickFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await setSeriesCoverBlob(ch, seriesLabel, file);
      frame.remove();
      after?.();
    } catch (e) {
      alert('No se pudo usar la imagen: ' + (e?.message || e));
    }
  };
  body.append(pickFile, fileInput);

  const grid = el('div', 'cover-pick-grid');
  body.append(el('div', 'info-sec', 'Números de la serie'));
  body.append(grid);

  const useCover = async (f) => {
    try {
      const b = await getCover(ch, f);
      if (!b) {
        alert('Este cómic aún no tiene portada en caché. Ábrelo una vez e inténtalo de nuevo.');
        return;
      }
      await setSeriesCoverBlob(ch, seriesLabel, b);
      frame.remove();
      after?.();
    } catch (e) {
      alert('No se pudo asignar la portada: ' + (e?.message || e));
    }
  };

  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    grid.append(el('div', 'info-loading', 'No hay cómics en esta serie.'));
  } else {
    for (const f of list) {
      const cell = el('button', 'cover-pick-cell');
      cell.type = 'button';
      const thumb = el('div', 'cover-pick-thumb');
      const lab = el('span', 'cover-pick-lab', issueLabel(seriesLabel, f, ch.name) || comicDisplay(f.name, ch.name));
      cell.append(thumb, lab);
      cell.onclick = () => useCover(f);
      grid.append(cell);
      (async () => {
        const b = await getCover(ch, f);
        if (!b || !thumb.isConnected) return;
        const img = new Image();
        img.onload = () => { thumb.replaceChildren(img); };
        img.src = URL.createObjectURL(b);
      })();
    }
  }

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
}

const channelCoverKey = (ch) => `cc:${ch.id}`;
async function getChannelCoverBlob(ch, files) {
  try {
    const b = await kv.get(channelCoverKey(ch));
    if (b instanceof Blob && b.size) return b;
  } catch (_) {}
  return firstAvailableCover(ch, files);
}
async function setChannelCoverBlob(ch, blob) {
  if (!blob) return;
  try {
    const opt = await optimizeImageBlob(blob, 384, 0.75);
    await kv.set(channelCoverKey(ch), opt || blob);
  } catch (e) {
    console.warn('channel cover', e);
    try { await kv.set(channelCoverKey(ch), blob); } catch (_) {}
  }
}
function channelReadProgress(ch, files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  let done = 0;
  for (const f of list) {
    if (isComicRead(ch.id, f.id)) done++;
  }
  if (done === 0) return null;
  return { done, tot: list.length, pct: Math.round((done / list.length) * 100) };
}

function applyCoverProgress(node, prog) {
  if (!node || !prog) return;
  node.querySelector?.('.prog')?.remove();
  node.querySelector?.('.prog-badge')?.remove();
  const bar = el('div', 'prog');
  const fill = el('div', 'prog-fill');
  fill.style.width = prog.pct + '%';
  bar.append(fill);
  node.append(bar);
  node.append(el('span', 'prog-badge', prog.pct >= 95 ? '✓' : prog.pct + '%'));
}

function channelCoverNode(ch, files) {
  const host = el('div', 'cover');
  const letter = el('span', '', (channelDisplayName(ch) || '?').slice(0, 1).toUpperCase());
  host.append(letter);
  const prog = channelReadProgress(ch, files);
  if (prog) applyCoverProgress(host, prog);

  const showOnHost = (blob) => {
    if (!blob || !host.isConnected) return;
    const img = new Image();
    img.onload = () => {
      if (!host.isConnected) return;
      host.replaceChildren(img);
      if (prog) applyCoverProgress(host, prog);
    };
    img.src = URL.createObjectURL(blob);
  };

  host._load = async () => {
    // 1) Portada manual del canal
    try {
      const custom = await kv.get(channelCoverKey(ch));
      if (custom instanceof Blob && custom.size) {
        showOnHost(custom);
        return;
      }
    } catch (_) {}

    // 2) Arte GitHub / public/channels
    try {
      const gh = await getGithubChannelArtBlob(ch);
      if (gh instanceof Blob && gh.size) {
        showOnHost(gh);
        return;
      }
    } catch (_) {}

    // 3) Primer cómic del canal con portada disponible (no solo el 1º archivo)
    try {
      const comic = await firstAvailableCover(ch, files);
      if (comic) {
        showOnHost(comic);
        return;
      }
    } catch (_) {}
  };
  io.observe(host);
  return host;
}
async function clearChannelCover(ch) {
  try { await kv.del(channelCoverKey(ch)); } catch (_) {}
}
async function getGithubChannelArtBlob(ch) {
  const key = `art:channels:${artNorm((ch.name || '').normalize('NFC').trim())}`;
  try {
    const cached = await kv.get(key);
    if (cached?.blob instanceof Blob && !cached.fromComic) return cached.blob;
    // Intentar cargar desde candidatos de ART
    const nfc = (ch.name || '').normalize('NFC').trim();
    const nfd = (ch.name || '').normalize('NFD').trim();
    const exts = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'JPG', 'JPEG', 'PNG', 'WEBP'];
    const seen = new Set();
    const candidates = [];
    const add = (u) => { if (u && !seen.has(u)) { seen.add(u); candidates.push(u); } };
    for (const n of [nfc, nfd, ch.name]) {
      if (!n) continue;
      add(ART.channels[artNorm(n)]);
      add(ART.channels[n.normalize('NFD').trim().toLowerCase()]);
      for (const e of exts) add(`/channels/${encodeURIComponent(n)}.${e}`);
    }
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob.size) continue;
        const opt = await optimizeImageBlob(blob, 384, 0.75);
        const meta = { blob: opt || blob, url, optimized: true };
        await kv.set(key, meta);
        return meta.blob;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

const groupCoverKey = (name) => `gc:${artNorm(String(name || ''))}`;
async function clearGroupCover(name) {
  try { await kv.del(groupCoverKey(name)); } catch (_) {}
}
async function setGroupCoverBlob(name, blob) {
  if (!blob) return;
  try {
    const opt = await optimizeImageBlob(blob, 384, 0.75);
    await kv.set(groupCoverKey(name), opt || blob);
  } catch (e) {
    try { await kv.set(groupCoverKey(name), blob); } catch (_) {}
  }
}
async function getGithubGroupArtBlob(name) {
  const key = `art:groups:${artNorm((name || '').normalize('NFC').trim())}`;
  try {
    const cached = await kv.get(key);
    if (cached?.blob instanceof Blob) return cached.blob;
    const nfc = (name || '').normalize('NFC').trim();
    const nfd = (name || '').normalize('NFD').trim();
    const exts = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'JPG', 'JPEG', 'PNG', 'WEBP'];
    const seen = new Set();
    const candidates = [];
    const add = (u) => { if (u && !seen.has(u)) { seen.add(u); candidates.push(u); } };
    for (const n of [nfc, nfd, name]) {
      if (!n) continue;
      add(ART.groups[artNorm(n)]);
      add(ART.groups[n.normalize('NFD').trim().toLowerCase()]);
      for (const e of exts) add(`/groups/${encodeURIComponent(n)}.${e}`);
    }
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob.size) continue;
        const opt = await optimizeImageBlob(blob, 384, 0.75);
        const meta = { blob: opt || blob, url, optimized: true };
        await kv.set(key, meta);
        return meta.blob;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}
function groupCoverNode(originalName) {
  const host = el('div', 'cover square');
  const letter = el('span', '', (groupDisplayName(originalName) || '?').slice(0, 1).toUpperCase());
  host.append(letter);
  host._load = async () => {
    try {
      const custom = await kv.get(groupCoverKey(originalName));
      if (custom instanceof Blob) {
        const img = new Image();
        img.onload = () => { host.replaceChildren(img); };
        img.src = URL.createObjectURL(custom);
        return;
      }
    } catch (_) {}
    const artNode = art('groups', originalName);
    if (host.parentNode) {
      host.replaceWith(artNode);
      artNode._load?.();
    } else {
      host.replaceChildren();
      host.append(artNode);
      artNode._load?.();
    }
  };
  io.observe(host);
  return host;
}
async function showGroupInfo(originalName) {
  try {
    document.querySelector('.info-frame.group-info')?.remove();
    const display = groupDisplayName(originalName);
    const chs = LIB.filter((c) => c.group === originalName);
    let comics = 0, bytes = 0;
    for (const ch of chs) {
      const files = (await kv.get('f:' + ch.id)) || [];
      comics += files.length;
      for (const f of files) bytes += Number(f.size) || 0;
    }
    const frame = el('div', 'info-frame group-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Información'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Editorial'));
    body.append(row('Nombre', display));
    if (display !== originalName) body.append(row('Nombre original', originalName));
    body.append(row('Canales', String(chs.length)));
    body.append(row('Cómics (listados)', String(comics)));
    body.append(row('Tamaño total', formatBytes(bytes)));
    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error(err);
    alert('No se pudo mostrar la información de la editorial');
  }
}
function showEditGroup(originalName, after) {
  sheet(groupDisplayName(originalName), [
    ['Editar nombre de la editorial', () => showEditGroupName(originalName, after)],
    ['Seleccionar portada de la editorial', () => showGroupCoverPicker(originalName, after)],
  ]);
}
function showEditGroupName(originalName, after) {
  document.querySelector('.info-frame.edit-group')?.remove();
  const current = groupDisplayName(originalName);
  const frame = el('div', 'info-frame edit-group');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar nombre'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', 'Nombre de la editorial'));
  const input = el('input', 'edit-input');
  input.type = 'text';
  input.value = current;
  input.autocomplete = 'off';
  body.append(input);
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = () => {
    setGroupDisplayName(originalName, input.value, () => {
      frame.remove();
      after?.();
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
  setTimeout(() => { input.focus(); input.select(); }, 50);
}
async function showGroupCoverPicker(originalName, after) {
  document.querySelector('.info-frame.cover-pick')?.remove();
  const title = groupDisplayName(originalName);
  const frame = el('div', 'info-frame cover-pick');
  const box = el('div', 'info-box cover-pick-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Portada de la editorial'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', title));
  body.append(el('p', 'cover-pick-hint', 'GitHub, un canal, un cómic o una imagen del dispositivo.'));

  const pickFile = el('button', 'btn cover-pick-device', '📁  Desde fotos o archivos');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  pickFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await setGroupCoverBlob(originalName, file);
      frame.remove();
      after?.();
    } catch (e) {
      alert('No se pudo usar la imagen: ' + (e?.message || e));
    }
  };
  body.append(pickFile, fileInput);

  const addCell = (parent, label, loadThumb, onPick) => {
    const cell = el('button', 'cover-pick-cell');
    cell.type = 'button';
    const thumb = el('div', 'cover-pick-thumb');
    const lab = el('span', 'cover-pick-lab', label);
    cell.append(thumb, lab);
    cell.onclick = onPick;
    parent.append(cell);
    Promise.resolve().then(loadThumb).then((b) => {
      if (!b || !thumb.isConnected) return;
      const img = new Image();
      img.onload = () => { thumb.replaceChildren(img); };
      img.src = URL.createObjectURL(b);
    }).catch(() => {});
  };

  const grid0 = el('div', 'cover-pick-grid');
  body.append(el('div', 'info-sec', 'Opciones'));
  body.append(grid0);
  addCell(grid0, 'GitHub / predeterminada', () => getGithubGroupArtBlob(originalName), async () => {
    await clearGroupCover(originalName);
    frame.remove();
    after?.();
  });

  const chs = LIB.filter((c) => c.group === originalName);
  if (chs.length) {
    body.append(el('div', 'info-sec', 'Canales'));
    const gridCh = el('div', 'cover-pick-grid');
    body.append(gridCh);
    for (const ch of chs) {
      addCell(gridCh, channelDisplayName(ch), async () => {
        try {
          const custom = await kv.get(channelCoverKey(ch));
          if (custom instanceof Blob) return custom;
        } catch (_) {}
        return getGithubChannelArtBlob(ch);
      }, async () => {
        let b = null;
        try {
          const custom = await kv.get(channelCoverKey(ch));
          if (custom instanceof Blob) b = custom;
        } catch (_) {}
        if (!b) b = await getGithubChannelArtBlob(ch);
        if (!b) {
          const files = (await kv.get('f:' + ch.id)) || [];
          if (files[0]) b = await getCover(ch, files[0]);
        }
        if (!b) {
          alert('Este canal aún no tiene portada en caché.');
          return;
        }
        await setGroupCoverBlob(originalName, b);
        frame.remove();
        after?.();
      });
    }

    body.append(el('div', 'info-sec', 'Cómics'));
    const gridComics = el('div', 'cover-pick-grid');
    body.append(gridComics);
    let any = false;
    for (const ch of chs) {
      const files = (await kv.get('f:' + ch.id)) || [];
      for (const f of files) {
        any = true;
        addCell(gridComics, comicDisplay(f.name, ch.name), () => getCover(ch, f), async () => {
          const b = await getCover(ch, f);
          if (!b) {
            alert('Este cómic aún no tiene portada en caché. Ábrelo una vez e inténtalo de nuevo.');
            return;
          }
          await setGroupCoverBlob(originalName, b);
          frame.remove();
          after?.();
        });
      }
    }
    if (!any) gridComics.append(el('div', 'info-loading', 'No hay cómics listados.'));
  }

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
}

async function showChannelInfo(ch) {
  try {
    document.querySelector('.info-frame.channel-info')?.remove();
    const display = channelDisplayName(ch);
    let files = (await kv.get('f:' + ch.id)) || [];
    const n = files.length;
    let bytes = 0;
    for (const f of files) bytes += Number(f.size) || 0;
    let seriesCount = 0;
    try {
      const groups = groupSeries(files, ch.name, seriesOverrideFor(ch));
      seriesCount = groups.filter((g) => g.files.length > 1).length;
    } catch (_) {}
    const frame = el('div', 'info-frame channel-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Información'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Canal'));
    body.append(row('Nombre', display));
    if (display !== ch.name) body.append(row('Nombre original', ch.name));
    body.append(row('Editorial', ch.group || '—'));
    body.append(row('Cómics', String(n)));
    body.append(row('Series (agrupadas)', String(seriesCount)));
    body.append(row('Tamaño total', formatBytes(bytes)));
    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error(err);
    alert('No se pudo mostrar la información del canal');
  }
}
function showEditChannel(ch, files, after) {
  sheet(channelDisplayName(ch), [
    ['Editar nombre del canal', () => showEditChannelName(ch, after)],
    ['Seleccionar portada del canal', () => showChannelCoverPicker(ch, files || [], after)],
  ]);
}
function showEditChannelName(ch, after) {
  document.querySelector('.info-frame.edit-channel')?.remove();
  const current = channelDisplayName(ch);
  const frame = el('div', 'info-frame edit-channel');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar nombre'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', 'Nombre del canal'));
  const input = el('input', 'edit-input');
  input.type = 'text';
  input.value = current;
  input.autocomplete = 'off';
  body.append(input);
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = () => {
    setChannelDisplayName(ch, input.value, () => {
      frame.remove();
      after?.();
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
  setTimeout(() => { input.focus(); input.select(); }, 50);
}
function showChannelCoverPicker(ch, files, after) {
  document.querySelector('.info-frame.cover-pick')?.remove();
  const title = channelDisplayName(ch);
  const frame = el('div', 'info-frame cover-pick');
  const box = el('div', 'info-box cover-pick-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Portada del canal'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', title));
  body.append(el('p', 'cover-pick-hint', 'Elige GitHub, un cómic del canal o una imagen del dispositivo.'));

  const pickFile = el('button', 'btn cover-pick-device', '📁  Desde fotos o archivos');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  pickFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await setChannelCoverBlob(ch, file);
      frame.remove();
      after?.();
    } catch (e) {
      alert('No se pudo usar la imagen: ' + (e?.message || e));
    }
  };
  body.append(pickFile, fileInput);

  const grid = el('div', 'cover-pick-grid');
  body.append(el('div', 'info-sec', 'Opciones'));
  body.append(grid);

  const addCell = (label, loadThumb, onPick) => {
    const cell = el('button', 'cover-pick-cell');
    cell.type = 'button';
    const thumb = el('div', 'cover-pick-thumb');
    const lab = el('span', 'cover-pick-lab', label);
    cell.append(thumb, lab);
    cell.onclick = onPick;
    grid.append(cell);
    Promise.resolve().then(loadThumb).then((b) => {
      if (!b || !thumb.isConnected) return;
      const img = new Image();
      img.onload = () => { thumb.replaceChildren(img); };
      img.src = URL.createObjectURL(b);
    }).catch(() => {});
    return cell;
  };

  // 1) Portada GitHub (quita la personalizada y restaura el flujo original)
  addCell('GitHub / predeterminada', () => getGithubChannelArtBlob(ch), async () => {
    await clearChannelCover(ch);
    // Si hay blob de GitHub, opcionalmente no hace falta guardarlo: art() lo carga solo
    frame.remove();
    after?.();
  });

  // 2) Todos los cómics del canal (también los de series desagrupadas)
  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    grid.append(el('div', 'info-loading', 'No hay cómics en este canal.'));
  } else {
    body.append(el('div', 'info-sec', 'Cómics del canal'));
    const gridComics = el('div', 'cover-pick-grid');
    body.append(gridComics);
    for (const f of list) {
      const cell = el('button', 'cover-pick-cell');
      cell.type = 'button';
      const thumb = el('div', 'cover-pick-thumb');
      const lab = el('span', 'cover-pick-lab', comicDisplay(f.name, ch.name));
      cell.append(thumb, lab);
      cell.onclick = async () => {
        const b = await getCover(ch, f);
        if (!b) {
          alert('Este cómic aún no tiene portada en caché. Ábrelo una vez e inténtalo de nuevo.');
          return;
        }
        await setChannelCoverBlob(ch, b);
        frame.remove();
        after?.();
      };
      gridComics.append(cell);
      (async () => {
        const b = await getCover(ch, f);
        if (!b || !thumb.isConnected) return;
        const img = new Image();
        img.onload = () => { thumb.replaceChildren(img); };
        img.src = URL.createObjectURL(b);
      })();
    }
  }

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
}

function cardNode(i) {
  const c = el('div', 'card');
  if (i.hiddenMeta) c.classList.add('card-locked');
  const hit = el('button', 'hit');
  hit.append(i.cover());
  hit.onclick = i.go;
  if (i.longPress) bindLongPress(hit, i.longPress);
  c.append(hit);
  // Contenido bloqueado: solo portada (Blur_candado), sin nombre ni subtítulo
  if (i.hiddenMeta) {
    hit.setAttribute('aria-label', 'Contenido bloqueado');
    return c;
  }
  const name = el('div', 'name');
  const t = el('b', '', i.label);
  if (i.menu) {
    t.classList.add('has-menu');
    t.onclick = (ev) => { ev.stopPropagation(); i.menu(); };
    t.title = 'Opciones';
    t.setAttribute('role', 'button');
  } else t.onclick = i.go;
  if (i.longPress) bindLongPress(t, i.longPress);
  name.append(t);
  c.append(name);
  if (i.sub) c.append(el('small', '', i.sub));
  return c;
}

/** Opciones Bloquear/Desbloquear para submenús */
function lockToggleOpts(kind, ref, label, redraw) {
  if (!locks.canUseLocks()) return [];
  const marked =
    kind === 'group' ? locks.isGroupMarked(ref)
    : kind === 'channel' ? locks.isChannelMarked(ref)
    : kind === 'series' ? locks.isSeriesMarked(ref.ch, ref.seriesLabel)
    : kind === 'comic' ? locks.isComicMarked(ref.ch, ref.f)
    : false;
  if (marked) {
    return [['Desbloquear', async () => {
      if (!locks.isSessionUnlocked()) {
        const pw = prompt('Contraseña de sincronización:');
        if (!(await locks.unlockSession(pw || ''))) return alert('Contraseña incorrecta');
      }
      if (kind === 'group') locks.setGroupLocked(ref, false);
      else if (kind === 'channel') locks.setChannelLocked(ref, false);
      else if (kind === 'series') locks.setSeriesLocked(ref.ch, ref.seriesLabel, false);
      else if (kind === 'comic') locks.setComicLocked(ref.ch, ref.f, false);
      redraw?.();
    }]];
  }
  return [['Bloquear', async () => {
    if (!locks.isSessionUnlocked()) {
      const pw = prompt('Contraseña de sincronización:');
      if (!(await locks.unlockSession(pw || ''))) return alert('Contraseña incorrecta');
    }
    if (kind === 'group') locks.setGroupLocked(ref, true);
    else if (kind === 'channel') locks.setChannelLocked(ref, true);
    else if (kind === 'series') locks.setSeriesLocked(ref.ch, ref.seriesLabel, true);
    else if (kind === 'comic') locks.setComicLocked(ref.ch, ref.f, true);
    redraw?.();
  }]];
}

function groupsView() {
  if (!LIB.length) return msg(synced ? 'No se encontraron canales ...::Comics::tgstorage.' : 'Conectando…');

  let searchIndex = null;
  let searchIndexPromise = null;
  const ensureIndex = () => {
    if (searchIndex) return Promise.resolve(searchIndex);
    if (searchIndexPromise) return searchIndexPromise;
    searchIndexPromise = buildSearchIndex({
      LIB,
      getFiles: async (ch) => (await kv.get('f:' + ch.id)) || [],
      groupDisplayName,
      channelDisplayName,
      seriesDisplayName,
      groupSeries,
      seriesOverrideFor,
      comicDisplay,
      comicDisplayName,
      openSeries: (ch, seriesLabel, fs) => seriesView(ch, seriesLabel, fs),
      openComic: (ch, f) => openComic(ch, f),
      openGroup: (g) => channelsView(g),
      openChannel: (ch) => filesView(ch),
    }).then((idx) => {
      searchIndex = idx;
      return idx;
    }).catch((e) => {
      console.warn('[search]', e);
      searchIndexPromise = null;
      return [];
    });
    return searchIndexPromise;
  };

  const paintHome = () => {
    const nodes = [];
    // Buscador general
    const searchWrap = el('div', 'home-search-wrap');
    const s = el('input');
    s.id = 'home-search';
    s.type = 'search';
    s.placeholder = 'Buscar editorial, canal, serie o cómic…';
    s.autocomplete = 'off';
    s.value = groupsView._q || '';
    const clearBtn = el('button', 'search-clear home-search-clear', '×');
    clearBtn.type = 'button';
    clearBtn.hidden = !s.value;
    clearBtn.setAttribute('aria-label', 'Cerrar búsqueda');
    clearBtn.onclick = () => {
      s.value = '';
      groupsView._q = '';
      clearBtn.hidden = true;
      showResults([], '');
      s.focus();
    };
    searchWrap.append(s, clearBtn);
    nodes.push(searchWrap);

    const resultsHost = el('div', 'home-search-results');
    resultsHost.hidden = true;
    nodes.push(resultsHost);

    const homeBody = el('div', 'home-body');
    nodes.push(homeBody);

    const fillHomeBody = () => {
      homeBody.replaceChildren();
      // Seguir leyendo: filtrar cómics que ya no existen en la caché del canal
      const rawContinue = getContinueList();
      const continueHost = el('div');
      homeBody.append(continueHost);
      (async () => {
        const continueList = [];
        const seen = new Set();
        const addItem = (item) => {
          if (!item?.ch?.id || !item?.f?.id) return;
          const id = String(item.ch.id) + ':' + String(item.f.id);
          if (seen.has(id)) return;
          if (isComicRead(item.ch.id, item.f.id)) return;
          // No mostrar en Seguir leyendo si está bloqueado (sesión cerrada)
          if (locks.isContentRestricted('comic', { ch: item.ch, f: item.f })) return;
          seen.add(id);
          continueList.push(item);
        };

        for (const item of rawContinue) {
          try {
            let files = (await kv.get('f:' + item.ch.id)) || [];
            if (!files.length) {
              try { files = await fetchFiles(item.ch); } catch (_) {}
            }
            if (!files.length) {
              // Sin listado aún: mantener el ítem (no borrar recentReads)
              addItem(item);
              continue;
            }
            const f = files.find((x) => String(x.id) === String(item.f.id));
            if (f) addItem({ ...item, f: { id: f.id, name: f.name, size: f.size } });
            // Si el listado existe y el archivo no está, no lo añadimos (purgado lógico)
          } catch (_) {
            addItem(item);
          }
        }

        // Progreso page: en localStorage aunque no esté en recentReads
        try {
          const lib = (Array.isArray(LIB) && LIB.length) ? LIB : ((await kv.get('lib')) || []);
          const byCh = new Map(lib.map((c) => [String(c.id), c]));
          for (const u of listUnfinishedProgress()) {
            const id = String(u.chId) + ':' + String(u.msgId);
            if (seen.has(id)) continue;
            const ch = byCh.get(String(u.chId));
            if (!ch) continue;
            let files = (await kv.get('f:' + ch.id)) || [];
            if (!files.length) {
              try { files = await fetchFiles(ch); } catch (_) {}
            }
            const f = files.find((x) => String(x.id) === String(u.msgId));
            if (f) addItem({ ch, f: { id: f.id, name: f.name, size: f.size }, at: Date.now() });
          }
        } catch (_) {}

        const renderContinue = (list) => {
          if (!continueHost.isConnected) return;
          const show = list.slice(0, 5);
          if (!show.length) {
            continueHost.replaceChildren();
            return;
          }
          const foldCont = el('details', 'pubs-fold continue-fold');
          if (pref('continueOpen', '1') === '1') foldCont.open = true;
          const sumCont = el('summary', '', 'Seguir leyendo');
          foldCont.append(sumCont);
          const contInner = el('div', 'continue-fold-body');
          const track = el('div', 'continue-track');
          for (const item of show) {
            const ch = item.ch, f = item.f;
            const prog = readProgress(ch.id, f.id);
            const row = el('button', 'continue-row continue-slide');
            row.type = 'button';
            row.onclick = () => openComic(ch, f);
            const contLabel = comicDisplayName(ch, f, comicDisplay(f.name, ch.name) || clean(f.name));
            const contUnread = !isComicRead(ch.id, f.id);
            const contOpts = [
              ['Información', () => showComicInfo(ch, f, contLabel)],
              ['Editar datos del comic', () => showEditComicTitle(ch, f, contLabel, () => {
                try { if (stack.length === 1) groupsView(); } catch (_) {}
              })],
              contUnread
                ? ['Marcar comic como leído', () => markComicRead(ch, f, () => renderContinue(continueList))]
                : ['Marcar comic como no leído', () => markComicUnread(ch, f, () => renderContinue(continueList))],
              ['Añadir versión WebP', () => { try { repackTool?.offerWebpVersion?.(ch, f); } catch (e) { alert(e?.message || e); } }],
            ];
            bindLongPress(row, () => sheet(contLabel, contOpts));
            const thumb = el('div', 'continue-cover');
            const letter = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
            thumb.append(letter);
            getCover(ch, f).then((b) => {
              if (!b || !thumb.isConnected) return;
              const img = new Image();
              img.onload = () => { letter.remove(); thumb.prepend(img); };
              img.src = URL.createObjectURL(b);
            }).catch(() => {});
            const meta = el('div', 'continue-meta');
            const channelLab = channelDisplayName(ch) || ch.name || '';
            let seriesLab = '';
            let titleLab = '';
            try {
              const ov = getComicSeriesOverride(ch, f);
              const p = parseComicName(f.name, ch.name);
              const sk = (ov != null && String(ov).trim()) ? String(ov).trim() : (p?.series || seriesBase(f.name, ch.name) || '');
              seriesLab = sk ? (seriesDisplayName(ch, sk) || sk) : '';
              // Mismo formato que el listado dentro de una serie (#nn - info)
              const baseLabel = p ? issueDisplay(p) : (issueLabel(sk || seriesLab, f, ch.name) || comicDisplay(f.name, ch.name) || clean(f.name));
              titleLab = comicDisplayName(ch, f, baseLabel);
            } catch (_) {
              titleLab = comicDisplayName(ch, f, comicDisplay(f.name, ch.name) || clean(f.name));
            }
            if (channelLab) meta.append(el('span', 'continue-channel', channelLab));
            if (seriesLab) meta.append(el('span', 'continue-series', seriesLab));
            meta.append(el('span', 'continue-title', titleLab));
            meta.append(el('small', '', sizeLabel(f, ch)));
            if (prog) {
              const bar = el('div', 'continue-prog');
              const fill = el('div', 'continue-prog-fill');
              fill.style.width = prog.pct + '%';
              bar.append(fill);
              const lab = el('span', 'continue-prog-label', `${prog.cur} / ${prog.tot} · ${prog.pct}%`);
              meta.append(bar, lab);
            }
            row.append(thumb, meta);
            track.append(row);
          }
          contInner.append(track);
          foldCont.append(contInner);
          foldCont.addEventListener('toggle', () => setPref('continueOpen', foldCont.open ? '1' : '0'));
          continueHost.replaceChildren(foldCont);
        };

        renderContinue(continueList);

        // Segundo plano: refrescar listados de canales con progreso pendiente
        (async () => {
          try {
            const lib = (Array.isArray(LIB) && LIB.length) ? LIB : ((await kv.get('lib')) || []);
            const byCh = new Map(lib.map((c) => [String(c.id), c]));
            const unfinished = listUnfinishedProgress();
            const chIds = [...new Set(unfinished.map((u) => String(u.chId)))];
            let added = false;
            for (const cid of chIds) {
              const ch = byCh.get(cid);
              if (!ch) continue;
              try {
                const files = await fetchFiles(ch);
                for (const u of unfinished.filter((x) => String(x.chId) === cid)) {
                  const id = cid + ':' + String(u.msgId);
                  if (seen.has(id)) continue;
                  const f = files.find((x) => String(x.id) === String(u.msgId));
                  if (f) {
                    addItem({ ch, f: { id: f.id, name: f.name, size: f.size }, at: Date.now() });
                    added = true;
                  }
                }
              } catch (_) {}
            }
            if (added && continueHost.isConnected) renderContinue(continueList);
          } catch (_) {}
        })();
        return; // el render antiguo queda sustituido
        const foldCont = el('details', 'pubs-fold continue-fold');
        if (pref('continueOpen', '1') === '1') foldCont.open = true;
        const sumCont = el('summary', '', 'Seguir leyendo');
        foldCont.append(sumCont);
        const contInner = el('div', 'continue-fold-body');
        const track = el('div', 'continue-track');
        for (const item of continueList) {
          const ch = item.ch, f = item.f;
          const prog = readProgress(ch.id, f.id);
          const row = el('button', 'continue-row continue-slide');
          row.type = 'button';
          row.onclick = () => {
            if (!locks.guardRestricted('comic', { ch, f }, comicDisplayName(ch, f, clean(f.name)))) return;
            openComic(ch, f);
          };
          let thumb = el('div', 'continue-cover');
          if (locks.isContentRestricted('comic', { ch, f })) {
            thumb = locks.lockedCoverNode(ART);
            thumb.classList.add('continue-cover');
          } else {
            const letter = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
            thumb.append(letter);
            getCover(ch, f).then((b) => {
              if (!b || !thumb.isConnected) return;
              const img = new Image();
              img.onload = () => { letter.remove(); thumb.prepend(img); };
              img.src = URL.createObjectURL(b);
            }).catch(() => {});
          }
          const meta = el('div', 'continue-meta');
          meta.append(el('b', '', comicDisplayName(ch, f, comicDisplay(f.name, ch.name) || clean(f.name))));
          meta.append(el('small', '', sizeLabel(f, ch)));
          if (prog) {
            const bar = el('div', 'continue-prog');
            const fill = el('div', 'continue-prog-fill');
            fill.style.width = prog.pct + '%';
            bar.append(fill);
            const lab = el('span', 'continue-prog-label', `${prog.cur} / ${prog.tot} · ${prog.pct}%`);
            meta.append(bar, lab);
          }
          row.append(thumb, meta);
          track.append(row);
        }
        contInner.append(track);
        foldCont.append(contInner);
        foldCont.addEventListener('toggle', () => setPref('continueOpen', foldCont.open ? '1' : '0'));
        continueHost.replaceChildren(foldCont);
      })();
      const gs = [...new Set(LIB.map((c) => c.group))];
      gs.sort((a, b) => natural(groupDisplayName(a), groupDisplayName(b)));
      const fold = el('details', 'pubs-fold');
      if (pref('pubsOpen', '0') === '1') fold.open = true;
      const sum = el('summary', '', 'Editoriales');
      fold.append(sum);
      const g = el('div', 'grid grid-pubs');
      const redrawPubs = () => groupsView();
      for (const name of gs) {
        const n = LIB.filter((c) => c.group === name).length;
        const label = groupDisplayName(name);
        const gRestricted = locks.isContentRestricted('group', name);
        g.append(cardNode({
          label: gRestricted ? '' : label,
          sub: gRestricted ? '' : (n === 1 ? '1 canal' : `${n} canales`),
          hiddenMeta: gRestricted,
          cover: () => gRestricted ? locks.lockedCoverNode(ART) : groupCoverNode(name),
          go: () => {
            if (!locks.guardRestricted('group', name, label)) return;
            channelsView(name);
          },
          longPress: () => {
            const opts = [
              ['Información', () => showGroupInfo(name)],
              ['Editar', () => showEditGroup(name, redrawPubs)],
            ];
            if (locks.canUseLocks()) {
              if (locks.isGroupMarked(name)) {
                opts.push(['Desbloquear', async () => {
                  if (!locks.isSessionUnlocked()) {
                    const pw = prompt('Contraseña de sincronización:');
                    if (!(await locks.unlockSession(pw || ''))) return alert('Contraseña incorrecta');
                  }
                  locks.setGroupLocked(name, false);
                  redrawPubs();
                }]);
              } else {
                opts.push(['Bloquear', () => {
                  if (!locks.isSessionUnlocked()) {
                    alert('Desbloquea el candado en Configuración para marcar contenido.');
                    return;
                  }
                  locks.setGroupLocked(name, true);
                  redrawPubs();
                }]);
              }
            }
            sheet(label, opts);
          },
        }));
      }
      fold.append(g);
      fold.addEventListener('toggle', () => setPref('pubsOpen', fold.open ? '1' : '0'));
      homeBody.append(fold);
    };

    const showResults = (list, q) => {
      resultsHost.replaceChildren();
      if (!q) {
        resultsHost.hidden = true;
        homeBody.hidden = false;
        return;
      }
      homeBody.hidden = true;
      resultsHost.hidden = false;
      if (!list.length) {
        resultsHost.append(el('p', 'home-search-empty', 'Sin resultados para «' + q + '»'));
        return;
      }
      const meta = el('div', 'home-search-meta', list.length + (list.length === 1 ? ' resultado' : ' resultados'));
      resultsHost.append(meta);
      const listEl = el('div', 'home-search-list');
      for (const item of list.slice(0, 80)) {
        const btn = el('button', 'home-search-row');
        btn.type = 'button';
        const badge = el('span', 'home-search-badge type-' + (item.type || ''), item.typeLabel || '');
        const text = el('div', 'home-search-text');
        text.append(el('b', '', item.label));
        if (item.sub) text.append(el('small', '', item.sub));
        btn.append(badge, text);
        btn.onclick = () => item.go?.();
        listEl.append(btn);
      }
      if (list.length > 80) {
        listEl.append(el('p', 'home-search-empty', 'Mostrando 80 de ' + list.length + '… Afina la búsqueda.'));
      }
      resultsHost.append(listEl);
    };

    let timer = null;
    s.oninput = () => {
      const q = s.value.trim();
      groupsView._q = s.value;
      clearBtn.hidden = !s.value;
      clearTimeout(timer);
      if (!q) {
        showResults([], '');
        return;
      }
      resultsHost.hidden = false;
      homeBody.hidden = true;
      resultsHost.replaceChildren(el('p', 'home-search-empty', 'Buscando…'));
      timer = setTimeout(async () => {
        const idx = await ensureIndex();
        let hits = filterSearchIndex(idx, q);
        if (pref('showUnreadOnly', '0') === '1') {
          hits = hits.filter((h) => {
            if (h.type === 'comic' && h.ch && h.f) return !isComicRead(h.ch.id, h.f.id);
            return true;
          });
        }
        if ((groupsView._q || '').trim() !== q) return;
        showResults(hits, q);
      }, 180);
    };

    app.replaceChildren(...nodes);
    fillHomeBody();
    if ((groupsView._q || '').trim()) {
      s.dispatchEvent(new Event('input'));
    }
    window.scrollTo(0, 0);
    lastScrollY = 0;
  };

  paintHome();
}
function channelsView(g) {
  if (!locks.guardRestricted('group', g, groupDisplayName(g))) return;

  go(groupDisplayName(g), async (e) => {
    e._uploadCtx = { editorial: g };
    const chs = LIB.filter((c) => c.group === g);
    let searchIndex = null;

    const buildIndex = async () => {
      // Mismo formato que el buscador general, acotado a esta editorial
      return buildSearchIndex({
        LIB: chs,
        getFiles: async (ch) => (await kv.get('f:' + ch.id)) || [],
        groupDisplayName,
        channelDisplayName,
        seriesDisplayName,
        groupSeries,
        comicDisplay,
        comicDisplayName,
        openSeries: (ch, seriesLabel, fs) => seriesView(ch, seriesLabel, fs),
        openComic: (ch, f) => openComic(ch, f),
        openGroup: () => {},
        openChannel: (ch) => filesView(ch),
      });
    };

    const build = async () => {
      if (!alive(e)) return;
      const gridItems = [];
      for (const ch of chs) {
        const files = (await kv.get('f:' + ch.id)) || [];
        const n = files.length;
        const label = channelDisplayName(ch);
        gridItems.push({
          label,
          sub: n ? (n === 1 ? '1 cómic' : `${n} cómics`) : '',
          cover: () => locks.isContentRestricted('channel', ch)
            ? locks.lockedCoverNode(ART)
            : channelCoverNode(ch, files),
          hiddenMeta: locks.isContentRestricted('channel', ch),
          label: locks.isContentRestricted('channel', ch) ? '' : label,
          sub: locks.isContentRestricted('channel', ch) ? '' : (n ? (n === 1 ? '1 cómic' : `${n} cómics`) : ''),
          isUnread: n ? files.some((f) => !isComicRead(ch.id, f.id)) : true,
          go: () => {
            if (!locks.guardRestricted('channel', ch, channelDisplayName(ch))) return;
            filesView(ch);
          },
          longPress: () => sheet(label, [
            ['Información', () => showChannelInfo(ch)],
            ['Editar', () => showEditChannel(ch, files, () => build())],
            ...lockToggleOpts('channel', ch, label, () => build()),
          ]),
        });
      }
      gridItems.sort((a, b) => natural(a.label, b.label));

      // UI: buscador estilo home + grid de canales (o lista de resultados)
      const nodes = [];
      const searchWrap = el('div', 'home-search-wrap');
      const s = el('input');
      s.type = 'search';
      s.placeholder = 'Buscar canal, serie o cómic en esta editorial…';
      s.autocomplete = 'off';
      s.value = channelsView._q?.[g] || '';
      const clearBtn = el('button', 'search-clear', '×');
      clearBtn.type = 'button';
      clearBtn.hidden = !s.value;
      clearBtn.setAttribute('aria-label', 'Cerrar búsqueda');
      searchWrap.append(s, clearBtn);
      nodes.push(searchWrap);

      const resultsHost = el('div', 'home-search-results');
      resultsHost.hidden = true;
      nodes.push(resultsHost);

      const gridHost = el('div', 'grid');
      nodes.push(gridHost);

      const paintGrid = () => {
        gridHost.hidden = false;
        resultsHost.hidden = true;
        gridHost.replaceChildren(...gridItems.map((i) => cardNode(i)));
      };

      const showResults = (list, q) => {
        resultsHost.replaceChildren();
        if (!q) {
          paintGrid();
          return;
        }
        gridHost.hidden = true;
        resultsHost.hidden = false;
        if (!list.length) {
          resultsHost.append(el('p', 'home-search-empty', 'Sin resultados para «' + q + '»'));
          return;
        }
        // No mostrar filas de tipo "group" (es la editorial actual)
        const filtered = list.filter((x) => x.type !== 'group');
        resultsHost.append(el('div', 'home-search-meta', filtered.length + (filtered.length === 1 ? ' resultado' : ' resultados')));
        const listEl = el('div', 'home-search-list');
        for (const item of filtered.slice(0, 100)) {
          const btn = el('button', 'home-search-row');
          btn.type = 'button';
          btn.append(
            el('span', 'home-search-badge type-' + (item.type || ''), item.typeLabel || ''),
            (() => {
              const text = el('div', 'home-search-text');
              text.append(el('b', '', item.label));
              if (item.sub) text.append(el('small', '', item.sub));
              return text;
            })()
          );
          btn.onclick = () => item.go?.();
          listEl.append(btn);
        }
        resultsHost.append(listEl);
      };

      let timer = null;
      const runSearch = () => {
        const q = s.value.trim();
        if (!channelsView._q) channelsView._q = {};
        channelsView._q[g] = s.value;
        clearBtn.hidden = !s.value;
        clearTimeout(timer);
        if (!q) {
          showResults([], '');
          return;
        }
        resultsHost.hidden = false;
        gridHost.hidden = true;
        resultsHost.replaceChildren(el('p', 'home-search-empty', 'Buscando…'));
        timer = setTimeout(async () => {
          if (!searchIndex) searchIndex = await buildIndex();
          let hits = filterSearchIndex(searchIndex, q);
          if (pref('showUnreadOnly', '0') === '1') {
            hits = hits.filter((h) => {
              if (h.type === 'comic' && h.ch && h.f) return !isComicRead(h.ch.id, h.f.id);
              return true;
            });
          }
          if ((channelsView._q?.[g] || '').trim() !== q) return;
          showResults(hits, q);
        }, 180);
      };
      clearBtn.onclick = () => { s.value = ''; runSearch(); s.focus(); };
      s.oninput = runSearch;

      app.replaceChildren(...nodes);
      if (s.value.trim()) runSearch();
      else paintGrid();
      window.scrollTo(0, 0);
      lastScrollY = 0;
    };

    await build();
    mapLimit(chs, 3, async (ch) => {
      try {
        const fresh = await fetchFiles(ch);
        const cached = await kv.get('f:' + ch.id);
        if (JSON.stringify(fresh) !== JSON.stringify(cached)) {
          searchIndex = null;
          await build();
        }
      } catch (_) {}
    });
  });
}
function filesView(ch) {
  if (!locks.guardRestricted('channel', ch, channelDisplayName(ch))) return;

  go(channelDisplayName(ch), async (e) => {
    e._uploadCtx = { editorial: ch.group || 'Sin editorial', channel: ch };
    e._chId = ch.id;
    let cur = [];
    const draw = (files) => {
      if (!alive(e)) return;
      cur = files;
      if (!files.length) return msg('No hay archivos CBZ/CBR en este canal.');
      const un = ungroupMap(ch), items = [], redraw = () => draw(cur);

      const makeComicItem = (f, displayLabel, seriesLabel, groupState, seriesFiles) => {
        // groupState: null = sin serie, 'grouped' | 'short' | 'full'
        const label = comicDisplayName(ch, f, displayLabel);
        const unread = !isComicRead(ch.id, f.id);
        const opts = [
          ['Información', () => showComicInfo(ch, f, label)],
          ['Editar datos del comic', () => showEditComicTitle(ch, f, label, redraw)],
        ];
        if (seriesLabel && groupState) {
          opts.push(['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, seriesFiles || [], redraw)]);
        }
        opts.push(unread
          ? ['Marcar comic como leído', () => markComicRead(ch, f, redraw)]
          : ['Marcar comic como no leído', () => markComicUnread(ch, f, redraw)]);
        // Solo la acción que proceda para la serie completa
        if (seriesLabel && seriesFiles && seriesFiles.length > 1) {
          const anyUnread = seriesFiles.some((x) => !isComicRead(ch.id, x.id));
          opts.push(anyUnread
            ? ['Marcar serie como leída', () => markSeriesRead(ch, seriesFiles, redraw)]
            : ['Marcar serie como no leída', () => markSeriesUnread(ch, seriesFiles, redraw)]);
        }
        if (groupState === 'short' || groupState === 'full') {
          opts.push(['Volver a agrupar la serie', () => setUngroupMode(ch, seriesLabel, null, redraw)]);
        } else if (groupState === 'grouped' && seriesFiles && seriesFiles.length > 1) {
          opts.push(['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)]);
          opts.push(['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)]);
        }
        opts.push(['Añadir versión WebP', () => {
          try { repackTool?.offerWebpVersion?.(ch, f); }
          catch (e) { alert(e?.message || e); }
        }]);
        const comicRestricted = locks.isContentRestricted('comic', { ch, f });
        return {
          label: comicRestricted ? '' : label,
          sub: comicRestricted ? '' : sizeLabel(f, ch),
          searchText: (label + ' ' + (f.name || '') + ' ' + (seriesLabel || '')).toLowerCase(),
          isUnread: unread,
          cover: () => comicRestricted ? locks.lockedCoverNode(ART) : comicCover(ch, f),
          hiddenMeta: comicRestricted,
          go: () => {
            if (!locks.guardRestricted('comic', { ch, f }, label)) return;
            openComic(ch, f, cur);
          },
          longPress: () => sheet(label, opts.concat(lockToggleOpts('comic', { ch, f }, label, redraw))),
          menu: (groupState && seriesLabel) ? () => sheet(seriesDisplayName(ch, seriesLabel), [
            ['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, seriesFiles || [], redraw)],
            ...lockToggleOpts('series', { ch, seriesLabel }, seriesDisplayName(ch, seriesLabel), redraw),
            ...(seriesFiles && seriesFiles.length > 1
              ? [seriesFiles.some((x) => !isComicRead(ch.id, x.id))
                  ? ['Marcar serie como leída', () => markSeriesRead(ch, seriesFiles, redraw)]
                  : ['Marcar serie como no leída', () => markSeriesUnread(ch, seriesFiles, redraw)]]
              : []),
            ...(groupState === 'grouped' && seriesFiles?.length > 1
              ? [['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)],
                 ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)]]
              : groupState === 'short' || groupState === 'full'
                ? [['Volver a agrupar la serie', () => setUngroupMode(ch, seriesLabel, null, redraw)]]
                : []),
          ]) : undefined,
        };
      };

      for (const { label: seriesLabel, files: fs } of groupSeries(files, ch.name, seriesOverrideFor(ch))) {
        const seriesShown = seriesDisplayName(ch, seriesLabel);
        if (fs.length === 1) {
          const f = fs[0];
          // Si el parseo detectó serie aunque sea 1 archivo, permitir editar nombre de serie
          const p = parseComicName(f.name, ch.name);
          const ov = getComicSeriesOverride(ch, f);
          const soloSeries = ov || p?.series || seriesLabel;
          const hasSeriesName = !!(ov || p?.series);
          items.push(makeComicItem(
            f,
            comicDisplay(f.name, ch.name),
            hasSeriesName ? soloSeries : null,
            hasSeriesName ? 'grouped' : null
          ));
          // Un solo número: no desagrupar; si hasSeriesName Editar título + Editar serie + Info
          if (hasSeriesName) {
            const it = items[items.length - 1];
            it.longPress = () => sheet(it.label, [
              ['Información', () => showComicInfo(ch, f, it.label)],
              ['Editar datos del comic', () => showEditComicTitle(ch, f, it.label, redraw)],
              ['Editar TODA la serie', () => showEditSeries(ch, soloSeries, fs, redraw)],
              !isComicRead(ch.id, f.id)
                ? ['Marcar comic como leído', () => markComicRead(ch, f, redraw)]
                : ['Marcar comic como no leído', () => markComicUnread(ch, f, redraw)],
              ['Añadir versión WebP', () => { try { repackTool?.offerWebpVersion?.(ch, f); } catch (e) { alert(e?.message || e); } }],
            ]);
            it.menu = undefined;
          }
        } else if (un[seriesLabel.toLowerCase()]) {
          const mode = un[seriesLabel.toLowerCase()];
          fs.forEach((f) => {
            const displayLabel = mode === 'short'
              ? issueLabel(seriesLabel, f, ch.name)
              : comicDisplay(f.name, ch.name);
            items.push(makeComicItem(f, displayLabel, seriesLabel, mode, fs));
          });
        } else {
          const seriesUnread = fs.some((f) => !isComicRead(ch.id, f.id));
          const seriesOpts = [
            ['Información', () => showSeriesInfo(ch, seriesLabel, fs)],
            ['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, fs, redraw)],
            seriesUnread
              ? ['Marcar serie como leída', () => markSeriesRead(ch, fs, redraw)]
              : ['Marcar serie como no leída', () => markSeriesUnread(ch, fs, redraw)],
            ['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)],
            ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)],
          ];
          const seriesSearch = (seriesShown + ' ' + seriesLabel + ' ' + fs.map((f) => f.name).join(' ')).toLowerCase();
          items.push({
            label: seriesShown,
            sub: `${fs.length} números`,
            searchText: seriesSearch,
            isUnread: seriesUnread,
            cover: () => locks.isContentRestricted('series', { ch, seriesLabel })
              ? locks.lockedCoverNode(ART)
              : seriesCoverNode(ch, seriesLabel, fs, fs.length),
            hiddenMeta: locks.isContentRestricted('series', { ch, seriesLabel }),
            label: locks.isContentRestricted('series', { ch, seriesLabel }) ? '' : seriesShown,
            go: () => {
              if (!locks.guardRestricted('series', { ch, seriesLabel }, seriesDisplayName(ch, seriesLabel))) return;
              seriesView(ch, seriesLabel, fs);
            },
            longPress: () => sheet(seriesDisplayName(ch, seriesLabel), [
              ...lockToggleOpts('series', { ch, seriesLabel }, seriesDisplayName(ch, seriesLabel), redraw),
            ]),
            longPress: () => sheet(seriesShown, seriesOpts),
            menu: () => sheet(seriesShown, seriesOpts),
          });
        }
      }
      // Orden alfabético por el nombre visible (incluye series renombradas)
      items.sort((a, b) => natural(a.label, b.label));
      grid(items, true, 'Buscar en este canal…');
    };
    const cached = await kv.get('f:' + ch.id);
    if (cached) draw(cached); else msg('Cargando…');
    try {
      const fresh = await fetchFiles(ch);
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) draw(fresh);
    } catch (err) { if (!cached) msg('Error: ' + err.message); }
  });
}
function seriesView(ch, s, files) {
  if (!locks.guardRestricted('series', { ch, seriesLabel: s }, seriesDisplayName(ch, s))) return;

  const title = seriesDisplayName(ch, s);
  go(title, (e) => {
    e._uploadCtx = { editorial: ch.group || 'Sin editorial', channel: ch, series: s };
    e._chId = ch.id;
    e._seriesKey = s;

    const loadSeriesFiles = async () => {
      let all = [];
      try { all = (await kv.get('f:' + ch.id)) || []; } catch (_) {}
      if (!all.length) {
        try { all = await fetchFiles(ch); } catch (_) {}
      }
      if (!all.length && Array.isArray(files) && files.length) all = files;
      const groups = groupSeries(all, ch.name, seriesOverrideFor(ch));
      const key = String(s || '').toLowerCase();
      let match = groups.find((g) => String(g.label || '').toLowerCase() === key);
      if (!match) {
        match = groups.find((g) =>
          String(seriesDisplayName(ch, g.label) || '').toLowerCase() === key
        );
      }
      return match ? match.files : (Array.isArray(files) ? files : []);
    };

    const redraw = async () => {
      if (!alive(e)) return;
      const fs = await loadSeriesFiles();
      if (!alive(e)) return;
      try {
        const t = seriesDisplayName(ch, s);
        if (titleEl) titleEl.textContent = t;
      } catch (_) {}
      const seriesUnread = fs.some((x) => !isComicRead(ch.id, x.id));
      const items = fs.map((f) => {
        const p = parseComicName(f.name, ch.name);
        const baseLabel = (p && String(p.series || '').toLowerCase() === String(s).toLowerCase())
          ? issueDisplay(p)
          : issueLabel(s, f, ch.name);
        const displayLabel = comicDisplayName(ch, f, baseLabel);
        const unread = !isComicRead(ch.id, f.id);
        const opts = [
          ['Información', () => showComicInfo(ch, f, displayLabel)],
          ['Editar datos del comic', () => showEditComicTitle(ch, f, displayLabel, redraw)],
          ['Editar TODA la serie', () => showEditSeries(ch, s, fs, () => {
            try { titleEl.textContent = seriesDisplayName(ch, s); } catch (_) {}
            redraw();
          })],
          unread
            ? ['Marcar comic como leído', () => markComicRead(ch, f, redraw)]
            : ['Marcar comic como no leído', () => markComicUnread(ch, f, redraw)],
          seriesUnread
            ? ['Marcar serie como leída', () => markSeriesRead(ch, fs, redraw)]
            : ['Marcar serie como no leída', () => markSeriesUnread(ch, fs, redraw)],
          ['Desagrupar serie', () => setUngroupMode(ch, s, 'short', () => history.back())],
          ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, s, 'full', () => history.back())],
          ['Añadir versión WebP', () => { try { repackTool?.offerWebpVersion?.(ch, f); } catch (err) { alert(err?.message || err); } }],
        ];
        return {
          label: displayLabel,
          sub: sizeLabel(f, ch),
          searchText: (displayLabel + ' ' + (f.name || '')).toLowerCase(),
          isUnread: unread,
          cover: () => locks.isContentRestricted('comic', { ch, f }) ? locks.lockedCoverNode(ART) : comicCover(ch, f),
          hiddenMeta: locks.isContentRestricted('comic', { ch, f }),
          go: () => openComic(ch, f, fs),
          longPress: () => sheet(displayLabel, opts.concat(lockToggleOpts('comic', { ch, f }, displayLabel, redraw))),
        };
      });
      grid(items, true, 'Buscar en esta serie…');
    };
    redraw();
  });
}

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
  const lab = comicDisplayName(ch, f, comicDisplay(f?.name || '', ch?.name) || '');
  if (!locks.guardRestricted('comic', { ch, f }, lab)) return;
  return openComicRaw(ch, f, queue, opts);
}

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
});



let uploadTool = {
  showUploadFrame() {
    alert('Subida no disponible. Revisa la consola o recarga la página.');
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
    getIsHome: () => stack.length < 2 && !document.getElementById('rd'),
    formatBytes: (n) => {
      const x = Number(n) || 0;
      if (x < 1024) return x + ' B';
      if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
      return (x / (1024 * 1024)).toFixed(2) + ' MB';
    },
    // Tras subir: refrescar listado del canal/serie en pantalla
    onUploadDone: async (ch) => {
      if (!ch?.id) return;
      try { await fetchFiles(ch); } catch (_) {}
      try {
        const top = stack[stack.length - 1];
        if (!top) return;
        const ctx = top._uploadCtx;
        if (ctx?.channel && String(ctx.channel.id) === String(ch.id)) {
          show(); // re-ejecuta seriesView/filesView con listado fresco
        } else if (String(top._chId) === String(ch.id)) {
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
  LIB = (await kv.get('lib')) || [];
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
