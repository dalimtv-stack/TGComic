import './style.css';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import * as zip from '@zip.js/zip.js';
import { createExtractorFromData } from 'node-unrar-js';
import rarWasm from 'node-unrar-js/esm/js/unrar.wasm?url';

const apiId = Number(import.meta.env.VITE_API_ID);
const apiHash = import.meta.env.VITE_API_HASH;
zip.configure({ useWebWorkers: false });

// ---------- Utilidades ----------
const SEP = '::', TSEP = ':', POST = SEP + 'tgstorage', LIBRARY = 'comics', MB = 1024 * 1024;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const pref = (k, d) => localStorage.getItem('pref:' + k) || d;
const setPref = (k, v) => localStorage.setItem('pref:' + k, v);
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
const stripExt = (n) => n.replace(/\.cb[zr]$/i, '');
// Progreso por canal+mensaje (evita colisiones entre canales)
const pageKey = (chId, msgId) => `page:${chId}:${msgId}`;
const pagesKey = (chId, msgId) => `pages:${chId}:${msgId}`;
const legacyPageKey = (msgId) => 'page:' + msgId;
const legacyPagesKey = (msgId) => 'pages:' + msgId;

function getPageIndex(chId, msgId) {
  const k = pageKey(chId, msgId);
  let v = localStorage.getItem(k);
  if (v == null) {
    // Migración desde clave antigua page:MSG_ID
    v = localStorage.getItem(legacyPageKey(msgId));
    if (v != null) {
      try { localStorage.setItem(k, v); } catch (_) {}
    }
  }
  return Math.max(0, +(v || 0) || 0);
}
function setPageIndex(chId, msgId, n) {
  try {
    localStorage.setItem(pageKey(chId, msgId), String(n));
    // Limpiar legado de este mensaje tras escribir la clave nueva
    localStorage.removeItem(legacyPageKey(msgId));
  } catch (_) {}
}
function getPagesTotal(chId, msgId) {
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
function setPagesTotal(chId, msgId, tot) {
  try {
    localStorage.setItem(pagesKey(chId, msgId), String(tot));
    localStorage.removeItem(legacyPagesKey(msgId));
  } catch (_) {}
}
const pageFmtKey = (chId, msgId) => `pagefmt:${chId}:${msgId}`;
function getPageFormat(chId, msgId) {
  try { return localStorage.getItem(pageFmtKey(chId, msgId)) || ''; } catch { return ''; }
}
function setPageFormat(chId, msgId, fmt) {
  try { if (fmt) localStorage.setItem(pageFmtKey(chId, msgId), fmt); } catch (_) {}
}
function detectPageFormats(pages) {
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

const sizeLabel = (f, ch) => {
  const mb = `${Math.round(f.size / MB)} MB`;
  const tot = ch ? getPagesTotal(ch.id, f.id) : 0;
  return tot > 0 ? `${mb} · ${tot} pág.` : mb;
};
const lastReadKey = 'lastRead';
const getLastRead = () => { try { return JSON.parse(localStorage.getItem(lastReadKey) || 'null'); } catch { return null; } };
const setLastRead = (ch, f) => {
  try {
    localStorage.setItem(lastReadKey, JSON.stringify({
      ch: { id: ch.id, hash: ch.hash, name: ch.name, group: ch.group },
      f: { id: f.id, name: f.name, size: f.size },
    }));
  } catch (_) {}
};
const readProgress = (chId, msgId) => {
  const cur = getPageIndex(chId, msgId);
  const tot = getPagesTotal(chId, msgId);
  if (!tot || tot < 1) return null;
  if (cur <= 0) return null;
  return { cur: cur + 1, tot, pct: Math.min(100, Math.round(((cur + 1) / tot) * 100)) };
};

// Nombre limpio: sin extensión, guiones bajos, etiquetas [..] (..) ni marcas @sitio
const clean = (n) => stripExt(n).replace(/_/g, ' ').replace(/\s*[(\[][^)\]]*[)\]]/g, '').replace(/\s*@\S+/g, '').replace(/\s+/g, ' ').trim();
// Número al final (legado); admite sufijo de letra (07b, 1a)
const NUM = /[\s._-]*(?:#|n[º°]\.?|no\.|vol\.?|cap\.?|issue|núm\.?|parte|part|tomo)?\s*\d+(?:\.\d+)?[a-zA-Z]?(?:\s*(?:de|of)\s*\d+)?\s*$/i;
const FIRST_ISSUE = /^(.+?)[\s._-]+(?:#|n[º°]\.?|no\.?|vol\.?|cap\.?|issue|núm\.?)?\s*\d+(?:\.\d+)?[a-zA-Z]?(?:\b|$)/i;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Quita (paréntesis) y [corchetes] del tramo info */
const cleanInfo = (s) => (s || '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\((?!\d+\s*de\s*\d+)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
/**
 * Formatos preferidos:
 * 1.  [channel] - [serie] #[n|Special|Especial|Extra] [- info]
 * 2.  [serie] #[n|Special|Especial|Extra] [- info]
 * 3.  [serie] [n|nX] [- info]   (sin #, p.ej. "Fabulas 07b - título")
 * No se muestra [channel]. [corchetes] ocultos.
 */
// Marcador: número (con opcional decimal y letra: 07b, 1a), o Special / Especial / Extra
const ISSUE_TAG = '(?:\\d+(?:\\.\\d+)?[a-zA-Z]?|Special|Especial|Extra)';
function parseComicName(name, channelName) {
  // Quitar [corchetes], @sitios y basura; dejar el patrón serie #n
  const raw = stripExt(name).replace(/_/g, ' ')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\((?!\d+\s*de\s*\d+)[^)]*\)/gi, '')
    .replace(/\s*@\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  const ch = (channelName || '').trim();
  const normTag = (tag) => {
    let number = String(tag || '').trim();
    const low = number.toLowerCase();
    if (low === 'special') return 'Special';
    if (low === 'especial') return 'Especial';
    if (low === 'extra') return 'Extra';
    return number;
  };
  const finish = (series, tag, info, rangeEnd) => {
    series = (series || '').trim();
    if (!series) return null;
    return {
      series,
      number: normTag(tag),
      rangeEnd: rangeEnd ? normTag(rangeEnd) : '',
      info: cleanInfo(info || ''),
      channel: ch || '',
    };
  };
  const stripCh = (series) => {
    if (!ch) return series;
    return series.replace(new RegExp(`^${escRe(ch)}\\s*-\\s*`, 'i'), '').trim() || series;
  };
  // Rango: "Crossed - Dead Or Alive #01 - #02"
  const reRange = new RegExp(`^(.+?)\\s*#\\s*(${ISSUE_TAG})\\s*-\\s*#\\s*(${ISSUE_TAG})\\s*$`, 'i');
  const mRange = raw.match(reRange);
  if (mRange) {
    const out = finish(stripCh(mRange[1]), mRange[2], '', mRange[3]);
    if (out) return out;
  }
  // Canal - serie #n [- info]
  if (ch) {
    const re1 = new RegExp(
      `^${escRe(ch)}\\s*-\\s*(.+?)\\s*#\\s*(${ISSUE_TAG})(?:\\s*-\\s*(.+))?\\s*$`,
      'i'
    );
    const m1 = raw.match(re1);
    if (m1) {
      // Evitar tratar "#01 - #02" como info si reRange falló por canal
      let info = m1[3] || '';
      const rangeInInfo = info.match(new RegExp(`^#\\s*(${ISSUE_TAG})\\s*$`, 'i'));
      if (rangeInInfo) {
        const out = finish(m1[1], m1[2], '', rangeInInfo[1]);
        if (out) return out;
      }
      const out = finish(m1[1], m1[2], info);
      if (out) return out;
    }
  }
  // Serie #n [- info]  (info no empieza por #n de rango ya cubierto)
  const re2 = new RegExp(`^(.+?)\\s*#\\s*(${ISSUE_TAG})(?:\\s*-\\s*(.+))?\\s*$`, 'i');
  const m2 = raw.match(re2);
  if (m2) {
    let info = m2[3] || '';
    const rangeInInfo = info.match(new RegExp(`^#\\s*(${ISSUE_TAG})\\s*$`, 'i'));
    if (rangeInInfo) {
      const out = finish(stripCh(m2[1]), m2[2], '', rangeInInfo[1]);
      if (out) return out;
    }
    const out = finish(stripCh(m2[1]), m2[2], info);
    if (out) return out;
  }
  // Sin #: Canal - serie 07b [- info]
  if (ch) {
    const re3 = new RegExp(
      `^${escRe(ch)}\\s*-\\s*(.+?)\\s+(${ISSUE_TAG})(?:\\s*-\\s*(.+))?\\s*$`,
      'i'
    );
    const m3 = raw.match(re3);
    if (m3) {
      const out = finish(m3[1], m3[2], m3[3] || '');
      if (out) return out;
    }
  }
  // Sin #: Serie 07b [- info]  (p.ej. "Fabulas 07b - 1001 Noches…")
  const re4 = new RegExp(`^(.+?)\\s+(${ISSUE_TAG})(?:\\s*-\\s*(.+))?\\s*$`, 'i');
  const m4 = raw.match(re4);
  if (m4) {
    const ser = stripCh(m4[1]);
    if (ser && ser.length >= 2 && !/^\d+$/.test(ser)) {
      const out = finish(ser, m4[2], m4[3] || '');
      if (out) return out;
    }
  }
  return null;
}
/** Etiqueta visible: "#01", "#01 - #02", "#Extra - Batmito 1" */
function issueDisplay(parsed) {
  if (!parsed) return '';
  if (parsed.rangeEnd) return `#${parsed.number} - #${parsed.rangeEnd}`;
  const base = '#' + parsed.number;
  return parsed.info ? `${base} - ${parsed.info}` : base;
}

function comicDisplay(name, channelName) {
  const p = parseComicName(name, channelName);
  if (p) {
    const iss = issueDisplay(p);
    return p.series ? `${p.series} ${iss}` : iss;
  }
  return clean(name);
}
/** Base de serie (legado si no hay formato nuevo) */
function seriesBase(name, channelName) {
  const p = parseComicName(name, channelName);
  if (p?.series) return p.series;
  const c = clean(name);
  if (!c) return '';
  const m = c.match(FIRST_ISSUE);
  if (m) {
    const base = m[1].replace(/[\s._-]+$/, '').trim();
    if (base.length >= 3 && !/^\d+$/.test(base)) return base;
  }
  const b = c.replace(NUM, '').replace(/[\s._-]+$/, '').trim();
  if (b && b !== c && b.length >= 3) return b;
  return '';
}
// Agrupa por serie; los especiales sin número que empiezan igual se unen
function groupSeries(files, channelName) {
  const by = new Map(), loose = [];
  for (const f of files) {
    const p = parseComicName(f.name, channelName);
    const b = p?.series || seriesBase(f.name, channelName);
    const c = p ? comicDisplay(f.name, channelName) : clean(f.name);
    if (b) {
      const k = b.toLowerCase();
      (by.get(k) || by.set(k, { label: b, files: [] }).get(k)).files.push(f);
    } else {
      loose.push([f, c]);
    }
  }
  const groups = [...by.values()], rest = [];
  for (const [f, c] of loose) {
    const cl = c.toLowerCase();
    const g = groups.filter((x) => {
      const l = x.label.toLowerCase();
      return cl.startsWith(l) && !/[\p{L}\d]/u.test(cl[l.length] || ' ');
    }).sort((x, y) => y.label.length - x.label.length)[0];
    if (g) g.files.push(f); else rest.push({ label: c, files: [f] });
  }
  return [...groups, ...rest]
    .map((g) => ({
      label: g.label,
      files: g.files.sort((x, y) => natural(comicDisplay(x.name, channelName), comicDisplay(y.name, channelName))),
    }))
    .sort((x, y) => natural(x.label, y.label));
}
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
async function collectAppStats() {
  const entries = await kv.entries();
  let covers = 0, art = 0, other = 0, coverN = 0, artN = 0;
  for (const [k, v] of entries) {
    const sz = sizeOfVal(v);
    if (typeof k === 'string' && k.startsWith('c:')) { covers += sz; coverN++; }
    else if (typeof k === 'string' && k.startsWith('art:')) { art += sz; artN++; }
    else other += sz;
  }
  const idbTotal = covers + art + other;

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

  return {
    idbTotal, covers, art, other, coverN, artN,
    lsBytes, sessionBytes, sessionOk, lsKeyCount: lsKeys.length,
    channels, comics, telegramBytes,
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
    out.push({ id: m.id, name, size: Number(m.document.size.toString()) });
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

// ---------- Portadas (primera imagen del CBZ, miniatura cacheada) ----------
const cq = []; let crun = 0, reading = false;
const enqueue = (fn) => new Promise((res) => { cq.push(() => fn().then(res, () => res(null))); pump(); });
function pump() { if (reading) return; while (crun < 2 && cq.length) { crun++; cq.shift()().finally(() => { crun--; pump(); }); } }

async function getCover(ch, f) {
  const key = `c:${ch.id}:${f.id}`;
  let b = await kv.get(key);
  if (b === 'none') b = undefined; // legacy: CBR marcados como none
  if (!b) b = await enqueue(() => makeCover(ch, f, key));
  return b && b !== 'none' ? b : null;
}
/** ¿El canvas puede exportar WebP? (se comprueba una vez) */
let _webpOk = null;
async function supportsWebP() {
  if (_webpOk != null) return _webpOk;
  _webpOk = await new Promise((res) => {
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      c.toBlob((b) => res(!!(b && b.type === 'image/webp')), 'image/webp', 0.8);
    } catch { res(false); }
  });
  return _webpOk;
}
/**
 * Redimensiona y comprime una imagen para caché.
 * maxEdge: lado mayor máximo en px. quality: 0–1.
 */
async function optimizeImageBlob(blob, maxEdge = 320, quality = 0.72) {
  if (!blob || !blob.size) return null;
  // Si ya es pequeña y WebP, no tocar
  if (blob.type === 'image/webp' && blob.size < 40 * 1024 && maxEdge >= 320) {
    try {
      const bmp = await createImageBitmap(blob);
      const ok = Math.max(bmp.width, bmp.height) <= maxEdge + 8;
      bmp.close?.();
      if (ok) return blob;
    } catch (_) {}
  }
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = el('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const webp = await supportsWebP();
  const type = webp ? 'image/webp' : 'image/jpeg';
  const out = await new Promise((r) => cv.toBlob(r, type, quality));
  // Si WebP salió mayor que el original, o falló, probar JPEG
  if (!out || (out.size >= blob.size && blob.size < 80 * 1024)) {
    if (type === 'image/webp') {
      const jpg = await new Promise((r) => cv.toBlob(r, 'image/jpeg', quality));
      return jpg && jpg.size < blob.size ? jpg : (jpg || out || blob);
    }
    return out && out.size < blob.size ? out : blob;
  }
  return out;
}
const thumbFromBlob = (blob) => optimizeImageBlob(blob, 280, 0.72);
async function saveCoverBlob(ch, f, blob) {
  if (!blob) return;
  const key = `c:${ch.id}:${f.id}`;
  try {
    const out = await thumbFromBlob(blob);
    if (out) await kv.set(key, out);
  } catch (e) { console.warn('portada', e); }
}
async function makeCover(ch, f, key) {
  const r = new TgReader(await getMsg(ch, f), f.size);
  // Solo CBZ en caliente; los CBR guardan portada al abrir el cómic
  if ((await sniff(r)) !== 'zip') return null;
  const zr = new zip.ZipReader(r);
  try {
    const first = pagesOf(await zr.getEntries())[0];
    if (!first) return null;
    const out = await thumbFromBlob(await pageBlob(first));
    if (out) await kv.set(key, out);
    return out;
  } finally { zr.close().catch(() => {}); }
}
const io = new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { io.unobserve(x.target); x.target._load?.(); } }), { rootMargin: '400px' });

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
menuPanel.append(menuInfoBtn, menuCfgBtn);
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
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
  document.body.append(frame);

  const row = (label, value) => {
    const r = el('div', 'info-row');
    r.append(el('span', 'info-label', label), el('span', 'info-value', value));
    return r;
  };

  collectAppStats().then((s) => {
    body.replaceChildren();
    body.append(el('div', 'info-sec', 'Caché (este dispositivo)'));
    body.append(row('Caché total (IndexedDB)', formatBytes(s.idbTotal)));
    body.append(row('Carátulas de cómics', `${formatBytes(s.covers)} · ${s.coverN} ítems`));
    body.append(row('Editoriales y canales', `${formatBytes(s.art)} · ${s.artN} ítems`));
    body.append(row('Otros datos en caché', formatBytes(s.other)));
    body.append(el('div', 'info-sec', 'Sesión y preferencias'));
    body.append(row('Sesión de Telegram', s.sessionOk ? `Guardada · ${formatBytes(s.sessionBytes)}` : 'No guardada'));
    body.append(row('localStorage (prefs, progreso…)', `${formatBytes(s.lsBytes)} · ${s.lsKeyCount} claves`));
    body.append(el('div', 'info-sec', 'Biblioteca'));
    body.append(row('Canales', String(s.channels)));
    body.append(row('Cómics (listados)', String(s.comics)));
    body.append(row('Tamaño en Telegram', formatBytes(s.telegramBytes)));
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

  box.append(head, body);
  frame.append(box);
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
  document.body.append(frame);
}
menuCfgBtn.onclick = (ev) => { ev.stopPropagation(); showViewerConfig(); };

let cleanup = null, LIB = [], synced = false;

function go(title, render) { stack.push({ title, render }); history.pushState(null, ''); show(); }
function show() {
  cleanup?.(); cleanup = null;
  const e = stack[stack.length - 1];
  titleEl.textContent = e.title;
  backBtn.hidden = stack.length < 2;
  $('#top')?.classList.toggle('home', stack.length < 2);
  // Reset scroll al cambiar de vista (evita entrar "descentrado")
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  lastScrollY = 0;
  headerHidden = false;
  $('#top')?.classList.remove('hide');
  e.render(e);
  // Por si el render asíncrono deja el scroll más abajo
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    lastScrollY = 0;
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

const ART = { groups: {}, channels: {} };
const artNorm = (s) => s.normalize('NFC').trim().toLowerCase();
const reg = (kind, files) => {
  for (const [p, url] of Object.entries(files)) {
    const base = decodeURIComponent(p.split('/').pop()).replace(/\.\w+$/i, '').trim();
    ART[kind][artNorm(base)] = url;
    ART[kind][base.normalize('NFD').trim().toLowerCase()] = url;
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
  const nameVars = [...new Set([nfc, nfd, name.trim()].filter(Boolean))];
  const candidates = [];
  const seen = new Set();
  const add = (u) => { if (u && !seen.has(u)) { seen.add(u); candidates.push(u); } };
  for (const n of nameVars) {
    add(ART[kind][artNorm(n)]);
    add(ART[kind][n.normalize('NFD').trim().toLowerCase()]);
  }
  for (const n of nameVars) {
    for (const e of exts) add(`/${kind}/${encodeURIComponent(n)}.${e}`);
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

  // Sin imagen en GitHub → portada del primer cómic del canal
  const fallbackComic = async () => {
    if (kind !== 'channels' || !ch) return false;
    try {
      let files = (await kv.get('f:' + ch.id)) || [];
      if (!files.length) {
        try { files = await fetchFiles(ch); } catch (_) { return false; }
      }
      if (!files.length) return false;
      const f = files[0];
      const b = await getCover(ch, f);
      if (!b) return false;
      await kv.set(key, { blob: b, url: `comic:${ch.id}:${f.id}`, fromComic: true });
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

function comicCover(ch, f, badge, series) {
  const d = el('div', 'cover'), ltr = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
  d.append(ltr);
  if (badge != null && badge !== '') {
    const b = el('span', series ? 'badge series' : 'badge', String(badge));
    d.append(b);
  }
  // Solo en cómics sueltos, nunca en la tarjeta de serie agrupada
  const prog = series ? null : readProgress(ch.id, f.id);
  if (prog) {
    const bar = el('div', 'prog');
    const fill = el('div', 'prog-fill');
    fill.style.width = prog.pct + '%';
    bar.append(fill);
    d.append(bar);
    const pb = el('span', 'prog-badge', prog.pct >= 95 ? '✓' : prog.pct + '%');
    d.append(pb);
  }
  d._load = async () => {
    const b = await getCover(ch, f);
    if (!b) return;
    const img = new Image();
    img.onload = () => { ltr.remove(); d.prepend(img); };
    img.src = URL.createObjectURL(b);
  };
  io.observe(d);
  return d;
}
/** Pulsación larga: el menú se abre AL SOLTAR (si no, el touchend cierra el sheet) */
function bindLongPress(node, fn, ms = 480) {
  if (!fn || !node) return;
  let timer = null, sx = 0, sy = 0, armed = false, opened = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const onStart = (e) => {
    const pt = e.touches ? e.touches[0] : e;
    sx = pt.clientX; sy = pt.clientY;
    armed = false;
    opened = false;
    clear();
    timer = setTimeout(() => {
      armed = true;
      try { navigator.vibrate?.(12); } catch (_) {}
      // Feedback visual opcional en la tarjeta
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
    if (armed && !opened) {
      opened = true;
      e.preventDefault();
      e.stopPropagation();
      // Abrir en el siguiente tick para no chocar con el touchend
      setTimeout(() => fn(e), 10);
    }
  };
  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchmove', onMove, { passive: true });
  node.addEventListener('touchend', onEnd, { passive: false });
  node.addEventListener('touchcancel', () => {
    clear();
    armed = false;
    node.classList.remove('long-press');
  }, { passive: true });
  // Escritorio: clic derecho
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn(e);
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

function showComicInfo(ch, f, displayTitle) {
  try {
    document.querySelector('.info-frame.comic-info')?.remove();
    const parsed = parseComicName(f?.name || '', ch?.name);
    let series = parsed?.series || seriesBase(f?.name || '', ch?.name) || '—';
    if (series !== '—' && ch) series = seriesDisplayName(ch, series);
    const parsedTitle = comicDisplay(f?.name || '', ch?.name) || '—';
    const title = (displayTitle && String(displayTitle).trim())
      || (ch && f ? comicDisplayName(ch, f, parsedTitle) : parsedTitle)
      || '—';
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
    head.append(el('span', '', 'Información'));
    const close = el('button', 'btn info-close', '×');
    close.setAttribute('aria-label', 'Cerrar');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Cómic'));
    body.append(row('Título', title));
    body.append(row('Serie', series));
    body.append(row('Canal', ch ? channelDisplayName(ch) : '—'));
    body.append(row('Editorial', ch?.group || '—'));
    body.append(row('Nombre archivo', fname || '—'));
    body.append(row('Formato archivo', fmt));
    body.append(row('Tamaño', formatBytes(f?.size)));
    body.append(row('Número de páginas', pagesLabel));
    body.append(row('Formato páginas', pageFmt));
    box.append(head, body);
    frame.append(box);
    frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
    document.body.append(frame);
  } catch (err) {
    console.error('showComicInfo', err);
    alert('No se pudo mostrar la información: ' + (err?.message || err));
  }
}


function grid(items, withSearch) {
  const g = el('div', 'grid'), nodes = [];
  const draw = (q = '') => g.replaceChildren(...items.filter((i) => i.label.toLowerCase().includes(q)).map((i) => {
    const c = el('div', 'card'), hit = el('button', 'hit'), name = el('div', 'name'), t = el('b', '', i.label);
    hit.append(i.cover());
    // Portada: abrir cómic / serie. Título: menú de opciones si existe, si no también abre.
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
  if (withSearch) { const s = el('input'); s.id = 'search'; s.type = 'search'; s.placeholder = 'Buscar…'; s.oninput = () => draw(s.value.toLowerCase().trim()); nodes.push(s); }
  nodes.push(g);
  app.replaceChildren(...nodes);
  draw();
  window.scrollTo(0, 0);
  lastScrollY = 0;
}
function sheet(title, opts) {
  const bg = el('div', 'sheet'), box = el('div', 'box'), close = () => bg.remove();
  box.append(el('div', 'sh-title', title));
  for (const [label, fn] of opts) { const b = el('button', 'btn', label); b.onclick = () => { close(); fn(); }; box.append(b); }
  const c = el('button', 'btn', 'Cancelar'); c.onclick = close;
  box.append(c);
  bg.onclick = (ev) => { if (ev.target === bg) close(); };
  bg.append(box);
  document.body.append(bg);
}
const ugKey = (ch) => 'ungroup:' + ch.id;
/** Mapa serie → 'short' | 'full' (legado: array → full) */
function ungroupMap(ch) {
  try {
    const raw = JSON.parse(localStorage.getItem(ugKey(ch)) || '{}');
    if (Array.isArray(raw)) {
      const m = {};
      for (const k of raw) m[String(k).toLowerCase()] = 'full';
      return m;
    }
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function setUngroupMode(ch, label, mode, after) {
  const m = ungroupMap(ch);
  const k = label.toLowerCase();
  if (!mode) delete m[k];
  else m[k] = mode;
  try { localStorage.setItem(ugKey(ch), JSON.stringify(m)); } catch (_) {}
  after?.();
}
/** Renombres de serie por canal (clave = nombre original en minúsculas) */
const snKey = (ch) => 'seriesName:' + ch.id;
function seriesRenameMap(ch) {
  try {
    const raw = JSON.parse(localStorage.getItem(snKey(ch)) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function seriesDisplayName(ch, originalLabel) {
  const m = seriesRenameMap(ch);
  return m[String(originalLabel || '').toLowerCase()] || originalLabel;
}
function setSeriesDisplayName(ch, originalLabel, newName, after) {
  const m = seriesRenameMap(ch);
  const k = String(originalLabel || '').toLowerCase();
  const n = String(newName || '').trim();
  if (!k) return after?.();
  if (!n || n.toLowerCase() === k) delete m[k];
  else m[k] = n;
  try { localStorage.setItem(snKey(ch), JSON.stringify(m)); } catch (_) {}
  after?.();
}
/** Renombres de título de cómic por canal (clave = file.id) */
const cnKey = (ch) => 'comicName:' + ch.id;
function comicRenameMap(ch) {
  try {
    const raw = JSON.parse(localStorage.getItem(cnKey(ch)) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function comicDisplayName(ch, f, fallback) {
  if (!ch || !f) return fallback || '';
  const m = comicRenameMap(ch);
  const custom = m[String(f.id)];
  if (custom != null && String(custom).trim()) return String(custom).trim();
  return fallback || '';
}
function setComicDisplayName(ch, f, newName, after) {
  if (!ch || !f?.id) return after?.();
  const m = comicRenameMap(ch);
  const k = String(f.id);
  const n = String(newName || '').trim();
  if (!n) delete m[k];
  else m[k] = n;
  try { localStorage.setItem(cnKey(ch), JSON.stringify(m)); } catch (_) {}
  after?.();
}
function showEditComicTitle(ch, f, currentLabel, after) {
  document.querySelector('.info-frame.edit-comic')?.remove();
  const fallback = comicDisplay(f?.name || '', ch?.name) || clean(f?.name || '') || '';
  const current = comicDisplayName(ch, f, currentLabel || fallback);
  const frame = el('div', 'info-frame edit-comic');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar título'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', 'Título del cómic'));
  const input = el('input', 'edit-input');
  input.type = 'text';
  input.value = current;
  input.autocomplete = 'off';
  body.append(input);
  const hint = el('p', 'cover-pick-hint', 'Deja vacío y guarda para restaurar el título original.');
  body.append(hint);
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = () => {
    const v = input.value.trim();
    // Vacío → borrar personalización; si coincide con el original parseado, también
    const toSave = (!v || v === fallback) ? '' : v;
    setComicDisplayName(ch, f, toSave, () => {
      frame.remove();
      after?.();
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
  document.body.append(frame);
  setTimeout(() => { input.focus(); input.select(); }, 50);
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
    body.append(el('div', 'info-sec', 'Serie'));
    body.append(row('Nombre', display));
    if (display !== seriesLabel) body.append(row('Nombre original', seriesLabel));
    body.append(row('Canal', ch ? channelDisplayName(ch) : '—'));
    body.append(row('Editorial', ch?.group || '—'));
    body.append(row('Números', String(n)));
    body.append(row('Tamaño total', formatBytes(bytes)));
    box.append(head, body);
    frame.append(box);
    frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
    document.body.append(frame);
  } catch (err) {
    console.error(err);
    alert('No se pudo mostrar la información');
  }
}
const seriesCoverKey = (ch, label) => `sc:${ch.id}:${String(label || '').toLowerCase()}`;
async function getSeriesCoverBlob(ch, seriesLabel, files) {
  try {
    const b = await kv.get(seriesCoverKey(ch, seriesLabel));
    if (b instanceof Blob) return b;
  } catch (_) {}
  if (files?.[0]) return getCover(ch, files[0]);
  return null;
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
function seriesCoverNode(ch, seriesLabel, files, badge) {
  const d = el('div', 'cover'), ltr = el('span', '', (seriesDisplayName(ch, seriesLabel) || seriesLabel || '?').slice(0, 1).toUpperCase());
  d.append(ltr);
  if (badge != null && badge !== '') {
    d.append(el('span', 'badge series', String(badge)));
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
    ['Editar nombre de la serie', () => showEditSeriesName(ch, seriesLabel, after)],
    ['Seleccionar portada de la serie', () => showSeriesCoverPicker(ch, seriesLabel, list, after)],
  ]);
}
function showEditSeriesName(ch, seriesLabel, after) {
  document.querySelector('.info-frame.edit-series')?.remove();
  const current = seriesDisplayName(ch, seriesLabel);
  const frame = el('div', 'info-frame edit-series');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar nombre'));
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
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = () => {
    setSeriesDisplayName(ch, seriesLabel, input.value, () => {
      frame.remove();
      after?.();
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
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
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
  document.body.append(frame);
}

/** Nombres y portadas de canal (por id de Telegram) */
const cnKey = 'channelNames';
function channelRenameMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(cnKey) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function channelDisplayName(ch) {
  if (!ch) return '—';
  const m = channelRenameMap();
  return m[String(ch.id)] || ch.name || '—';
}
function setChannelDisplayName(ch, newName, after) {
  const m = channelRenameMap();
  const id = String(ch.id);
  const n = String(newName || '').trim();
  if (!n || n === ch.name) delete m[id];
  else m[id] = n;
  try { localStorage.setItem(cnKey, JSON.stringify(m)); } catch (_) {}
  after?.();
}
const channelCoverKey = (ch) => `cc:${ch.id}`;
async function getChannelCoverBlob(ch, files) {
  try {
    const b = await kv.get(channelCoverKey(ch));
    if (b instanceof Blob) return b;
  } catch (_) {}
  // Portada GitHub / fallback cómic vía art no aplica aquí; usar primer cómic si hay
  if (files?.[0]) return getCover(ch, files[0]);
  return null;
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
function channelCoverNode(ch) {
  // Si hay portada personalizada se muestra; si no, el mismo flujo que antes (GitHub / cómic)
  const host = el('div', 'cover');
  const letter = el('span', '', (channelDisplayName(ch) || '?').slice(0, 1).toUpperCase());
  host.append(letter);
  host._load = async () => {
    try {
      const custom = await kv.get(channelCoverKey(ch));
      if (custom instanceof Blob) {
        const img = new Image();
        img.onload = () => { host.replaceChildren(img); };
        img.src = URL.createObjectURL(custom);
        return;
      }
    } catch (_) {}
    // Sin personalizada → comportamiento original (GitHub + fallback)
    const artNode = art('channels', ch.name, ch);
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

/** Editoriales (groups): nombre y portada */
const gnKey = 'groupNames';
function groupRenameMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(gnKey) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function groupDisplayName(name) {
  const n = String(name || '');
  const m = groupRenameMap();
  return m[n.toLowerCase()] || n || '—';
}
function setGroupDisplayName(originalName, newName, after) {
  const m = groupRenameMap();
  const k = String(originalName || '').toLowerCase();
  const n = String(newName || '').trim();
  if (!k) return after?.();
  if (!n || n.toLowerCase() === k || n === originalName) delete m[k];
  else m[k] = n;
  try { localStorage.setItem(gnKey, JSON.stringify(m)); } catch (_) {}
  after?.();
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
    frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
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
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
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
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
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
      const groups = groupSeries(files, ch.name);
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
    frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
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
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
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
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
  document.body.append(frame);
}

/** Etiqueta de número sin el nombre de la serie */
function issueLabel(series, f, channelName) {
  const p = parseComicName(f.name, channelName);
  if (p && p.series.toLowerCase() === series.toLowerCase()) return issueDisplay(p);
  const c = clean(f.name);
  let r = c.toLowerCase().startsWith(series.toLowerCase()) ? c.slice(series.length) : c;
  r = r.replace(/^[\s._-]+/, '');
  if (/^\d/.test(r)) r = '#' + r;
  return r || c;
}

function cardNode(i) {
  const c = el('div', 'card'), hit = el('button', 'hit'), name = el('div', 'name'), t = el('b', '', i.label);
  hit.append(i.cover());
  hit.onclick = i.go;
  if (i.longPress) bindLongPress(hit, i.longPress);
  if (i.menu) {
    t.classList.add('has-menu');
    t.onclick = (ev) => { ev.stopPropagation(); i.menu(); };
    t.title = 'Opciones';
    t.setAttribute('role', 'button');
  } else t.onclick = i.go;
  if (i.longPress) bindLongPress(t, i.longPress);
  name.append(t);
  c.append(hit, name);
  if (i.sub) c.append(el('small', '', i.sub));
  return c;
}
function groupsView() {
  if (!LIB.length) return msg(synced ? 'No se encontraron canales ...::Comics::tgstorage.' : 'Conectando…');
  const nodes = [];
  const last = getLastRead();
  if (last?.ch?.id && last?.f?.id) {
    const sec = el('section', 'continue');
    sec.append(el('div', 'sec-title', 'Seguir leyendo'));
    const ch = last.ch, f = last.f;
    const prog = readProgress(ch.id, f.id);
    const row = el('button', 'continue-row');
    row.type = 'button';
    row.onclick = () => openComic(ch, f);
    // Portada pequeña
    const thumb = el('div', 'continue-cover');
    const letter = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
    thumb.append(letter);
    getCover(ch, f).then((b) => {
      if (!b || !thumb.isConnected) return;
      const img = new Image();
      img.onload = () => { letter.remove(); thumb.prepend(img); };
      img.src = URL.createObjectURL(b);
    }).catch(() => {});
    // Texto a la derecha
    const meta = el('div', 'continue-meta');
    meta.append(el('b', '', comicDisplayName(ch, f, comicDisplay(f.name, ch.name) || clean(f.name))));
    meta.append(el('small', '', sizeLabel(f, ch)));
    if (prog) {
      const bar = el('div', 'continue-prog');
      const fill = el('div', 'continue-prog-fill');
      fill.style.width = prog.pct + '%';
      bar.append(fill);
      const lab = el('span', 'continue-prog-label', prog.pct >= 95 ? '✓ Completado' : `${prog.cur} / ${prog.tot} · ${prog.pct}%`);
      meta.append(bar, lab);
    }
    row.append(thumb, meta);
    sec.append(row);
    nodes.push(sec);
    nodes.push(el('div', 'sec-sep'));
  }
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
    g.append(cardNode({
      label,
      sub: n === 1 ? '1 canal' : `${n} canales`,
      cover: () => groupCoverNode(name),
      go: () => channelsView(name),
      longPress: () => sheet(label, [
        ['Información', () => showGroupInfo(name)],
        ['Editar', () => showEditGroup(name, redrawPubs)],
      ]),
    }));
  }
  fold.append(g);
  fold.addEventListener('toggle', () => setPref('pubsOpen', fold.open ? '1' : '0'));
  nodes.push(fold);
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
  lastScrollY = 0;
}
function channelsView(g) {
  go(groupDisplayName(g), async (e) => {
    const chs = LIB.filter((c) => c.group === g);
    const build = async () => {
      const items = [];
      for (const ch of chs) {
        const files = (await kv.get('f:' + ch.id)) || [];
        const n = files.length;
        const label = channelDisplayName(ch);
        items.push({
          label,
          sub: n ? (n === 1 ? '1 cómic' : `${n} cómics`) : '',
          cover: () => channelCoverNode(ch),
          go: () => filesView(ch),
          longPress: () => sheet(label, [
            ['Información', () => showChannelInfo(ch)],
            ['Editar', () => showEditChannel(ch, files, () => build())],
          ]),
        });
      }
      items.sort((a, b) => natural(a.label, b.label));
      if (alive(e)) grid(items, true);
    };
    await build();
    // refrescar listados en segundo plano para rellenar conteos
    mapLimit(chs, 3, async (ch) => {
      try {
        const fresh = await fetchFiles(ch);
        const cached = await kv.get('f:' + ch.id);
        if (JSON.stringify(fresh) !== JSON.stringify(cached)) await build();
      } catch (_) {}
    });
  });
}
function filesView(ch) {
  go(channelDisplayName(ch), async (e) => {
    let cur = [];
    const draw = (files) => {
      if (!alive(e)) return;
      cur = files;
      if (!files.length) return msg('No hay archivos CBZ/CBR en este canal.');
      const un = ungroupMap(ch), items = [], redraw = () => draw(cur);

      const makeComicItem = (f, displayLabel, seriesLabel, groupState, seriesFiles) => {
        // groupState: null = sin serie, 'grouped' | 'short' | 'full'
        const label = comicDisplayName(ch, f, displayLabel);
        const opts = [
          ['Información', () => showComicInfo(ch, f, label)],
          ['Editar título', () => showEditComicTitle(ch, f, label, redraw)],
        ];
        if (seriesLabel && groupState) {
          opts.push(['Editar serie', () => showEditSeries(ch, seriesLabel, seriesFiles || [], redraw)]);
        }
        if (groupState === 'short' || groupState === 'full') {
          opts.push(['Volver a agrupar la serie', () => setUngroupMode(ch, seriesLabel, null, redraw)]);
        } else if (groupState === 'grouped') {
          opts.push(['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)]);
          opts.push(['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)]);
        }
        return {
          label,
          sub: sizeLabel(f, ch),
          cover: () => comicCover(ch, f),
          go: () => openComic(ch, f, cur),
          longPress: () => sheet(label, opts),
          menu: groupState ? () => sheet(seriesDisplayName(ch, seriesLabel), opts.filter((o) => o[0] !== 'Información')) : undefined,
        };
      };

      for (const { label: seriesLabel, files: fs } of groupSeries(files, ch.name)) {
        const seriesShown = seriesDisplayName(ch, seriesLabel);
        if (fs.length === 1) {
          const f = fs[0];
          // Si el parseo detectó serie aunque sea 1 archivo, permitir editar nombre de serie
          const p = parseComicName(f.name, ch.name);
          const soloSeries = p?.series || seriesLabel;
          const hasSeriesName = !!(p?.series);
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
              ['Editar título', () => showEditComicTitle(ch, f, it.label, redraw)],
              ['Editar serie', () => showEditSeries(ch, soloSeries, fs, redraw)],
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
          const seriesOpts = [
            ['Información', () => showSeriesInfo(ch, seriesLabel, fs)],
            ['Editar', () => showEditSeries(ch, seriesLabel, fs, redraw)],
            ['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)],
            ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)],
          ];
          items.push({
            label: seriesShown,
            sub: `${fs.length} números`,
            cover: () => seriesCoverNode(ch, seriesLabel, fs, fs.length),
            go: () => seriesView(ch, seriesLabel, fs),
            longPress: () => sheet(seriesShown, seriesOpts),
            menu: () => sheet(seriesShown, seriesOpts),
          });
        }
      }
      // Orden alfabético por el nombre visible (incluye series renombradas)
      items.sort((a, b) => natural(a.label, b.label));
      grid(items, true);
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
  const title = seriesDisplayName(ch, s);
  go(title, () => {
    const redraw = () => {
      // Re-render series view with updated labels
      const items = files.map((f) => {
        const p = parseComicName(f.name, ch.name);
        const baseLabel = (p && p.series.toLowerCase() === s.toLowerCase())
          ? issueDisplay(p)
          : issueLabel(s, f, ch.name);
        const displayLabel = comicDisplayName(ch, f, baseLabel);
        const opts = [
          ['Información', () => showComicInfo(ch, f, displayLabel)],
          ['Editar título', () => showEditComicTitle(ch, f, displayLabel, redraw)],
          ['Editar serie', () => showEditSeries(ch, s, files, () => {
            titleEl.textContent = seriesDisplayName(ch, s);
            redraw();
          })],
          ['Desagrupar serie', () => setUngroupMode(ch, s, 'short', () => history.back())],
          ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, s, 'full', () => history.back())],
        ];
        return {
          label: displayLabel,
          sub: sizeLabel(f, ch),
          cover: () => comicCover(ch, f),
          go: () => openComic(ch, f, files),
          longPress: () => sheet(displayLabel, opts),
        };
      });
      grid(items, true);
    };
    redraw();
  });
}

// ---------- Lector ----------
async function resolveQueue(ch, f) {
  try {
    let files = (await kv.get('f:' + ch.id)) || [];
    if (!files.length) files = await fetchFiles(ch);
    for (const { files: fs } of groupSeries(files, ch.name)) {
      if (fs.some((x) => x.id === f.id)) return fs.length > 1 ? fs : files;
    }
    return files;
  } catch { return [f]; }
}

function openComic(ch, f, queue, opts = {}) {
  const start = async (e) => {
    e._isComic = true;
    reading = true;
    const ac = { cancelled: false };
    let rdClean = null;
    cleanup = () => { ac.cancelled = true; reading = false; pump(); rdClean?.(); };
    msg('Abriendo…');
    try {
      setLastRead(ch, f);
      const status = (t) => { if (!cancelled(ac) && alive(e)) msg(t); };
      const list = queue && queue.length ? queue : await resolveQueue(ch, f);
      const idx = Math.max(0, list.findIndex((x) => x.id === f.id));
      const arc = await openPages(await getMsg(ch, f), f.size, status, ac);
      if (cancelled(ac) || !alive(e)) { try { arc.close(); } catch (_) {} return; }
      if (!arc.pages.length) return msg('No se encontraron imágenes.');
      pageBlob(arc.pages[0]).then((b) => saveCoverBlob(ch, f, b)).catch(() => {});
      rdClean = reader(f, arc.pages, arc, { ch, list, idx });
    } catch (err) {
      if (err?.cancelled || cancelled(ac)) return;
      if (alive(e)) msg('Error: ' + err.message);
    }
  };
  const comicTitle = comicDisplayName(ch, f, comicDisplay(f.name, ch.name) || stripExt(f.name));
  if (opts.replace && stack.length) {
    cleanup?.(); cleanup = null;
    stack.pop();
    stack.push({ title: comicTitle, render: start, _isComic: true });
    try { history.replaceState(null, ''); } catch (_) {}
    show();
  } else {
    go(comicTitle, start);
  }
}

function reader(f, pages, zr, ctx) {
  const chId = ctx?.ch?.id;
  const savePage = (i) => { if (chId != null) setPageIndex(chId, f.id, i); };
  if (chId != null) {
    setPagesTotal(chId, f.id, pages.length);
    const fmt = detectPageFormats(pages);
    if (fmt) setPageFormat(chId, f.id, fmt);
  }
  let n = Math.min(chId != null ? getPageIndex(chId, f.id) : 0, pages.length - 1);
  const urls = new Map();
  const load = (i) => {
    if (i < 0 || i >= pages.length) return null;
    if (!urls.has(i)) {
      const p = pageBlob(pages[i]).then((b) => URL.createObjectURL(b));
      p.catch(() => urls.delete(i));
      urls.set(i, p);
    }
    return urls.get(i);
  };
  const drop = (i) => { urls.get(i)?.then((u) => URL.revokeObjectURL(u), () => {}); urls.delete(i); };
  const hasNext = !!(ctx?.list && ctx.idx >= 0 && ctx.idx < ctx.list.length - 1);
  const openNext = () => {
    if (!hasNext) return;
    savePage(pages.length - 1);
    openComic(ctx.ch, ctx.list[ctx.idx + 1], ctx.list, { replace: true });
  };

  const mount = () => {
    n = Math.min(chId != null ? getPageIndex(chId, f.id) : (n || 0), pages.length - 1);
    let mode = pref('mode', 'page');
    if (mode !== 'page' && mode !== 'vertical' && mode !== 'horizontal') mode = 'page';
    const vert = mode === 'vertical';
    const horiz = mode === 'horizontal';
    const continuous = vert || horiz;
    let token = 0, observers = [];
    const rd = el('div'); rd.id = 'rd';
    // Barra superior: título + estado de modo
    const top = el('div', 'bar topbar');
    const modeName = { page: 'Página', vertical: 'Vertical', horizontal: 'Horizontal' };
    const fitName = { screen: 'Pantalla', width: 'Ancho' };
    const status = el('div', 'rd-status');
    const updateStatus = () => {
      const m = pref('mode', 'page');
      const f = pref('fit', 'screen') === 'width' ? 'width' : 'screen';
      status.replaceChildren();
      const dot = () => { const s = el('span', 'rd-dot'); s.textContent = '●'; return s; };
      const bit = (label) => {
        const w = el('span', 'rd-status-bit');
        w.append(document.createTextNode(label + ' '), dot());
        return w;
      };
      status.append(bit('Modo: ' + (modeName[m] || m)));
      if (m !== 'page') status.append(bit('Ajuste: ' + fitName[f]));
      else status.append(bit('Ajuste: ' + fitName[f]));
    };
    updateStatus();
    const titleCol = el('div', 'rd-titlecol');
    const rdTitle = (ctx?.ch)
      ? comicDisplayName(ctx.ch, f, comicDisplay(f.name, ctx.ch.name) || stripExt(f.name))
      : stripExt(f.name);
    titleCol.append(el('span', 'ttl', rdTitle), status);
    top.append(titleCol);
    // Barra inferior: controles
    const bot = el('div', 'bar botbar');
    const back = el('button', 'btn', '‹');
    back.setAttribute('aria-label', 'Atrás');
    back.onclick = () => history.back();
    const mb = modeBtn(() => {
      savePage(n);
      unmount();
      unmount = mount();
    });
    const gridBtn = el('button', 'btn grid-btn', '▦');
    gridBtn.setAttribute('aria-label', 'Mosaico de páginas');
    gridBtn.title = 'Páginas';
    const cnt = el('span', 'cnt');
    const setCount = () => (cnt.textContent = `${n + 1} / ${pages.length}`);
    const cluster = el('div', 'bot-cluster');
    cluster.append(back, mb);
    bot.append(cluster);
    document.body.append(rd);
    document.body.style.overflow = 'hidden';
    let uiTimer = setTimeout(() => rd.classList.add('ui-off'), 2500);
    const pokeUI = () => {
      rd.classList.remove('ui-off');
      clearTimeout(uiTimer);
      uiTimer = setTimeout(() => rd.classList.add('ui-off'), 2500);
    };

    const showMosaic = () => {
      pokeUI();
      const overlay = el('div', 'mosaic');
      const head = el('div', 'mosaic-head');
      head.append(el('span', '', 'Páginas'), el('button', 'btn', 'Cerrar'));
      head.querySelector('button').onclick = () => overlay.remove();
      const g = el('div', 'mosaic-grid');
      const thumbs = [];
      for (let i = 0; i < pages.length; i++) {
        const cell = el('button', 'mosaic-cell' + (i === n ? ' on' : ''));
        cell.type = 'button';
        cell.append(el('span', 'mosaic-num', String(i + 1)));
        const ph = el('div', 'mosaic-ph');
        cell.append(ph);
        cell.onclick = () => {
          overlay.remove();
          goToPage(i);
        };
        g.append(cell);
        thumbs.push({ i, ph, cell });
      }
      overlay.append(head, g);
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
      document.body.append(overlay);
      // Miniaturas acotadas (no reutilizar el layout del lector)
      (async () => {
        for (const { i, ph } of thumbs) {
          if (!overlay.isConnected) return;
          try {
            const u = await load(i);
            const im = el('img');
            im.alt = String(i + 1);
            im.decoding = 'async';
            im.loading = 'lazy';
            im.src = u;
            ph.replaceChildren(im);
          } catch (_) {}
          if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
        }
      })();
    };
    gridBtn.onclick = showMosaic;

    let goToPage = (i) => {}; // se asigna en cada modo

    if (!continuous) {
      rd.className = 'page fit-' + pref('fit', 'screen');
      const fit = el('button', 'btn');
      let img = el('img');
      const fitLabel = () => (fit.textContent = pref('fit', 'screen') === 'screen' ? '↔ Ancho' : '⤢ Pantalla');
      fit.onclick = () => {
        setPref('fit', pref('fit', 'screen') === 'screen' ? 'width' : 'screen');
        rd.className = rd.className.replace(/fit-\w+/, 'fit-' + pref('fit', 'screen'));
        fitLabel();
        updateStatus();
        pokeUI();
      };
      fitLabel();
      cluster.append(gridBtn, fit, cnt);
      img.draggable = false;
      const eL = el('div', 'edge l'), eR = el('div', 'edge r');
      rd.append(img, eL, eR, top, bot);
      const turn = async (i) => {
        if (i > pages.length - 1) { if (hasNext) openNext(); return; }
        if (i < 0) return;
        const t = Math.max(0, Math.min(pages.length - 1, i));
        if (t === n && img.src) return;
        n = t; savePage(n); setCount(); rd.classList.remove('zoom');
        const mine = ++token;
        try {
          const u = await load(n);
          if (mine !== token) return;
          const im = el('img'); im.draggable = false; im.src = u;
          await im.decode().catch(() => {});
          if (mine !== token) return;
          img.replaceWith(im); img = im; rd.scrollTo(0, 0);
          for (const i2 of [...urls.keys()]) if (i2 < n - 2 || i2 > n + 4) drop(i2);
          for (const k of [1, 2, 3]) { if (token !== mine) return; await Promise.resolve(load(n + k)).catch(() => {}); }
        } catch (err) { cnt.textContent = 'Error'; console.error(err); }
      };
      goToPage = (i) => turn(i);
      eL.onclick = () => turn(n - 1);
      eR.onclick = () => turn(n + 1);
      let last = 0, tapT;
      rd.onclick = (ev) => {
        if (ev.target.closest?.('.bar, .edge, .mosaic')) return;
        if (ev.target.tagName !== 'IMG') return;
        const t = Date.now();
        if (t - last < 300) { clearTimeout(tapT); last = 0; rd.classList.toggle('zoom'); }
        else { last = t; tapT = setTimeout(() => rd.classList.toggle('ui-off'), 300); }
      };
      let sx = null, sy = 0;
      rd.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { sx = null; return; }
        const x = e.touches[0].clientX, y = e.touches[0].clientY;
        // Borde izquierdo iOS: no contar (gesto atrás del sistema)
        if (x < 48) { sx = null; return; }
        sx = x; sy = y;
      }, { passive: true });
      rd.addEventListener('touchend', (e) => {
        if (sx === null || (window.visualViewport?.scale || 1) > 1.05 || rd.classList.contains('zoom')) return;
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
        sx = null;
        // Deslizar de arriba hacia abajo → cerrar (como atrás)
        if (dy > 90 && dy > 1.6 * Math.abs(dx)) {
          history.back();
          return;
        }
        // Horizontal → cambiar página
        if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) turn(dx < 0 ? n + 1 : n - 1);
      }, { passive: true });
      document.onkeydown = (e) => { if (e.key === 'ArrowRight') turn(n + 1); if (e.key === 'ArrowLeft') turn(n - 1); };
      const onWheel = (e) => {
        e.preventDefault();
        if (e.deltaY > 10) turn(n + 1);
        else if (e.deltaY < -10) turn(n - 1);
      };
      rd.addEventListener('wheel', onWheel, { passive: false });
      observers._wheel = onWheel;
      const onOrientPage = () => {
        resetMobileViewport();
        rd.style.width = window.innerWidth + 'px';
        rd.style.height = window.innerHeight + 'px';
        rd.className = 'page fit-' + pref('fit', 'screen');
        if (img) { const s = img.src; img.src = ''; img.src = s; }
      };
      let rt = 0;
      const onOrientPageD = () => { clearTimeout(rt); rt = setTimeout(onOrientPage, 120); };
      addEventListener('resize', onOrientPageD);
      addEventListener('orientationchange', onOrientPageD);
      observers._resize = onOrientPageD;
      turn(n);
    } else {
      const GAP = 8; // hueco uniforme siempre
      const fitMode = () => (pref('fit', 'screen') === 'width' ? 'width' : 'screen');
      rd.className = (horiz ? 'horiz' : 'vert') + ' fit-' + fitMode();
      const fit = el('button', 'btn');
      const fitLabel = () => (fit.textContent = fitMode() === 'screen' ? '↔ Ancho' : '⤢ Pantalla');
      let onResize = null;
      fit.onclick = () => {
        setPref('fit', fitMode() === 'screen' ? 'width' : 'screen');
        rd.className = (horiz ? 'horiz' : 'vert') + ' fit-' + fitMode();
        fitLabel();
        updateStatus();
        pokeUI();
        onResize?.();
      };
      fitLabel();
      cluster.append(gridBtn, fit, cnt);

      const vw = () => Math.round(window.visualViewport?.width || window.innerWidth);
      const vh = () => Math.round(window.visualViewport?.height || window.innerHeight);
      // Estimación inicial estable (evita saltos)
      const estSize = () => {
        if (horiz) return fitMode() === 'width' ? vw() : Math.round(Math.min(vw(), vh() * 0.75));
        return fitMode() === 'width' ? Math.round(vw() * 1.4) : Math.min(vh(), Math.round(vw() * 1.4));
      };
      const sizes = new Array(pages.length).fill(estSize());
      const slots = pages.map((_, i) => {
        const d = el('div', 'slot');
        d.dataset.i = i;
        if (horiz) {
          d.style.flex = 'none';
          d.style.width = sizes[i] + 'px';
          d.style.minWidth = sizes[i] + 'px';
          d.style.height = '100%';
          d.style.marginRight = GAP + 'px';
          d.style.marginBottom = '0';
        } else {
          d.style.width = '100%';
          d.style.height = sizes[i] + 'px';
          d.style.minHeight = sizes[i] + 'px';
          d.style.marginBottom = GAP + 'px';
          d.style.marginRight = '0';
        }
        return d;
      });
      // Sin padding inicial (causaba doble hueco)
      const foot = el('div', 'next-comic');
      if (hasNext) {
        const nb = el('button', 'btn next-btn', 'Siguiente número →');
        nb.onclick = (ev) => { ev.stopPropagation(); openNext(); };
        foot.append(nb);
      } else {
        foot.append(el('div', 'next-end', 'Fin'));
      }
      rd.append(...slots, foot, top, bot);

      const loaded = new Map();
      let syncLock = true;
      let scrollT = 0;

      const posOf = (i) => {
        let y = 0;
        for (let k = 0; k < i; k++) y += sizes[k] + GAP;
        return y;
      };
      const pageAt = (mid) => {
        let y = 0;
        for (let k = 0; k < pages.length; k++) {
          const h = sizes[k] + GAP;
          if (y + h > mid) return k;
          y += h;
        }
        return pages.length - 1;
      };

      /** Aplica estilos de imagen según eje + ajuste */
      const applyImg = (im, slot) => {
        const screen = fitMode() === 'screen';
        im.style.display = 'block';
        im.style.margin = '0 auto';
        im.style.objectFit = 'contain';
        if (horiz) {
          if (screen) {
            // Cabe entera → centrada
            im.style.width = 'auto';
            im.style.height = 'auto';
            im.style.maxWidth = vw() + 'px';
            im.style.maxHeight = vh() + 'px';
            im.style.flexShrink = '0';
            slot.style.overflow = 'hidden';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
          } else {
            // Ancho = 100% del viewport
            im.style.width = '100%';
            im.style.maxWidth = '100%';
            im.style.height = 'auto';
            im.style.maxHeight = 'none';
            im.style.flex = 'none';
            im.style.flexShrink = '0';
            slot.style.overflowX = 'hidden';
            slot.style.overflowY = 'auto';
            slot.style.webkitOverflowScrolling = 'touch';
            // Centrado o arriba se decide en place() según si es alta
          }
          slot.style.height = '100%';
          slot.style.maxHeight = '100%';

        } else {
          if (screen) {
            im.style.width = 'auto';
            im.style.height = 'auto';
            im.style.maxWidth = '100%';
            im.style.maxHeight = vh() + 'px';
          } else {
            im.style.width = '100%';
            im.style.maxWidth = '100%';
            im.style.height = 'auto';
            im.style.maxHeight = 'none';
          }
          slot.style.overflow = 'hidden';
          slot.style.width = '100%';
          slot.style.display = 'flex';
          slot.style.justifyContent = 'center';
          slot.style.alignItems = 'flex-start';
        }
      };

      const measure = (im, slot) => {
        if (horiz) {
          // El eje de scroll horizontal es el ancho de página (= viewport en Ancho)
          if (fitMode() === 'width') return Math.max(1, vw());
          return Math.max(1, Math.round(im.getBoundingClientRect().width) || im.offsetWidth || sizes[0]);
        }
        return Math.max(1, Math.round(im.getBoundingClientRect().height) || im.offsetHeight || sizes[0]);
      };

      const place = (i, im) => {
        const slot = slots[i];
        const prev = sizes[i];
        slot.replaceChildren(im);
        applyImg(im, slot);
        const h = measure(im, slot);
        sizes[i] = h;
        if (horiz) {
          slot.style.width = h + 'px';
          slot.style.minWidth = h + 'px';
          slot.style.marginRight = GAP + 'px';
          if (fitMode() === 'width') {
            const imgH = im.offsetHeight || im.naturalHeight || 0;
            const viewH = (window.visualViewport?.height || vh());
            const tall = imgH > viewH + 4;
            slot.dataset.tall = tall ? '1' : '0';
            if (tall) {
              // Más alta que la pantalla: scroll desde el flujo normal (no recentrar)
              slot.style.display = 'block';
              slot.style.overflowY = 'auto';
              slot.style.alignItems = '';
              slot.style.justifyContent = '';
            } else {
              // Cabe entera: centrada
              slot.style.display = 'flex';
              slot.style.alignItems = 'center';
              slot.style.justifyContent = 'center';
              slot.style.overflowY = 'hidden';
              slot.scrollTop = 0;
            }
          } else {
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.overflowY = 'hidden';
            slot.dataset.tall = '0';
          }
        } else {
          slot.style.height = h + 'px';
          slot.style.minHeight = h + 'px';
          slot.style.marginBottom = GAP + 'px';
        }
        const delta = h - prev;
        if (!syncLock && delta) {
          if (horiz && posOf(i) + Math.min(prev, h) <= rd.scrollLeft + 2) rd.scrollLeft += delta;
          if (!horiz && posOf(i) + Math.min(prev, h) <= rd.scrollTop + 2) rd.scrollTop += delta;
        }
      };

      const ensure = async (i) => {
        if (i < 0 || i >= pages.length || loaded.has(i)) return;
        loaded.set(i, true);
        try {
          const im = el('img');
          im.decoding = 'async';
          im.draggable = false;
          im.src = await load(i);
          await im.decode().catch(() => {});
          if (!slots[i].isConnected) return;
          place(i, im);
        } catch {
          loaded.delete(i);
        }
      };

      const jumpTo = (i) => {
        i = Math.max(0, Math.min(pages.length - 1, i));
        const p = posOf(i);
        if (horiz) rd.scrollLeft = p;
        else rd.scrollTop = p;
      };

      goToPage = async (i) => {
        i = Math.max(0, Math.min(pages.length - 1, i));
        n = i;
        savePage(n);
        setCount();
        syncLock = true;
        jumpTo(i);
        await ensure(i);
        jumpTo(i);
        ensure(i - 1); ensure(i + 1); ensure(i + 2);
        requestAnimationFrame(() => {
          jumpTo(i);
          setTimeout(() => { syncLock = false; }, 150);
        });
      };

      const onScroll = () => {
        if (syncLock) return;
        clearTimeout(scrollT);
        scrollT = setTimeout(() => {
          const mid = horiz
            ? rd.scrollLeft + rd.clientWidth * 0.35
            : rd.scrollTop + rd.clientHeight * 0.35;
          const idx = pageAt(mid);
          if (idx !== n) {
            n = idx;
            savePage(n);
            setCount();
          }
          for (let k = n - 2; k <= n + 4; k++) ensure(k);
          for (const i of [...loaded.keys()]) {
            if (Math.abs(i - n) <= 10) continue;
            const s = slots[i];
            if (horiz) {
              s.style.width = sizes[i] + 'px';
              s.style.minWidth = sizes[i] + 'px';
            } else {
              s.style.height = sizes[i] + 'px';
              s.style.minHeight = sizes[i] + 'px';
            }
            s.replaceChildren();
            loaded.delete(i);
            drop(i);
          }
        }, 80);
      };
      rd.addEventListener('scroll', onScroll, { passive: true });

      const loadIO = new IntersectionObserver((es) => {
        es.forEach((x) => { if (x.isIntersecting) ensure(+x.target.dataset.i); });
      }, { root: rd, rootMargin: horiz ? '0px 80%' : '80% 0px' });
      slots.forEach((s) => loadIO.observe(s));
      observers = [loadIO];
      observers._scroll = onScroll;

      rd.onclick = (ev) => {
        if (ev.target.closest?.('.bar, .next-btn, .mosaic')) return;
        rd.classList.toggle('ui-off');
      };

      onResize = () => {
        resetMobileViewport();
        const w = vw(), h = vh();
        rd.style.width = w + 'px';
        rd.style.height = h + 'px';
        // Reaplicar a todas las cargadas
        for (let i = 0; i < pages.length; i++) {
          const im = slots[i].querySelector('img');
          if (im) place(i, im);
          else {
            const e = estSize();
            sizes[i] = e;
            if (horiz) {
              slots[i].style.width = e + 'px';
              slots[i].style.minWidth = e + 'px';
              slots[i].style.marginRight = GAP + 'px';
            } else {
              slots[i].style.height = e + 'px';
              slots[i].style.minHeight = e + 'px';
              slots[i].style.marginBottom = GAP + 'px';
            }
          }
        }
        requestAnimationFrame(() => {
          jumpTo(n);
          setTimeout(() => jumpTo(n), 200);
        });
      };
      let resizeT = 0;
      const onOrient = () => { clearTimeout(resizeT); resizeT = setTimeout(onResize, 80); };
      addEventListener('resize', onOrient);
      addEventListener('orientationchange', onOrient);
      if (window.visualViewport) {
        visualViewport.addEventListener('resize', onOrient);
        observers._vv = onOrient;
      }
      observers._resize = onOrient;

      // Horizontal + Ancho + página alta: bloqueo de eje con arrastre suave
      // - Vertical: scroll interno de la página
      // - Horizontal: mueve el strip con el dedo y al soltar encaja la página
      if (horiz) {
        let axis = null, sx = 0, sy = 0, baseLeft = 0, baseTop = 0, activeSlot = null;
        let lastX = 0, lastT = 0, velX = 0;
        const snapTo = (idx) => {
          idx = Math.max(0, Math.min(pages.length - 1, idx));
          const target = posOf(idx);
          try {
            rd.scrollTo({ left: target, behavior: 'smooth' });
          } catch (_) {
            rd.scrollLeft = target;
          }
          if (idx !== n) {
            n = idx;
            savePage(n);
            setCount();
            // No forzar scrollTop=0: respeta dónde estaba / inicio natural
            ensure(idx - 1); ensure(idx); ensure(idx + 1); ensure(idx + 2);
          }
        };
        const onTs = (e) => {
          if (e.touches.length !== 1) { axis = null; return; }
          axis = null;
          velX = 0;
          sx = lastX = e.touches[0].clientX;
          sy = e.touches[0].clientY;
          lastT = performance.now();
          baseLeft = rd.scrollLeft;
          activeSlot = slots[n];
          baseTop = activeSlot ? activeSlot.scrollTop : 0;
        };
        const onTm = (e) => {
          if (fitMode() !== 'width' || !activeSlot || activeSlot.dataset.tall !== '1') return;
          if (e.touches.length !== 1) return;
          const x = e.touches[0].clientX, y = e.touches[0].clientY;
          const dx = x - sx, dy = y - sy;
          if (!axis) {
            if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
            axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
          }
          if (axis === 'x') {
            e.preventDefault();
            // 1:1 con el dedo
            rd.scrollLeft = baseLeft - dx;
            const now = performance.now();
            const dt = Math.max(1, now - lastT);
            velX = (x - lastX) / dt;
            lastX = x;
            lastT = now;
          } else if (axis === 'y') {
            e.preventDefault();
            // 1:1 vertical (sin saltar al top)
            activeSlot.scrollTop = Math.max(0, baseTop - dy);
          }
        };
        const onTe = () => {
          if (axis === 'x') {
            const w = Math.max(1, sizes[n] || rd.clientWidth);
            const offset = rd.scrollLeft - posOf(n);
            let idx = n;
            // Poco recorrido basta (~15%) o un flick ligero
            if (offset > w * 0.15 || velX < -0.25) idx = Math.min(pages.length - 1, n + 1);
            else if (offset < -w * 0.15 || velX > 0.25) idx = Math.max(0, n - 1);
            snapTo(idx);
          }
          axis = null;
          activeSlot = null;
          velX = 0;
        };
        rd.addEventListener('touchstart', onTs, { passive: true });
        rd.addEventListener('touchmove', onTm, { passive: false });
        rd.addEventListener('touchend', onTe, { passive: true });
        rd.addEventListener('touchcancel', onTe, { passive: true });
        observers._touchStart = onTs;
        observers._touchMove = onTm;
        observers._touchEnd = onTe;

        // PC: rueda vertical en página alta; al borde, cambiar página
        const onWheelH = (e) => {
          if (fitMode() !== 'width') return;
          const slot = slots[n];
          if (!slot || slot.dataset.tall !== '1') return;
          const canY = slot.scrollHeight > slot.clientHeight + 2;
          if (!canY) return;
          const atTop = slot.scrollTop <= 0;
          const atBot = slot.scrollTop + slot.clientHeight >= slot.scrollHeight - 2;
          if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBot)) return;
          if (Math.abs(e.deltaY) > 12) {
            e.preventDefault();
            snapTo(e.deltaY > 0 ? n + 1 : n - 1);
          }
        };
        rd.addEventListener('wheel', onWheelH, { passive: false });
        observers._wheel = onWheelH;
      }

      goToPage(n);
    }
    setCount();
    return () => {
      clearTimeout(uiTimer);
      observers.forEach((o) => { try { o.disconnect(); } catch (_) {} });
      if (observers._scroll) rd.removeEventListener('scroll', observers._scroll);
      if (observers._wheel) rd.removeEventListener('wheel', observers._wheel);
      if (observers._touchStart) rd.removeEventListener('touchstart', observers._touchStart);
      if (observers._touchMove) rd.removeEventListener('touchmove', observers._touchMove);
      if (observers._touchEnd) {
        rd.removeEventListener('touchend', observers._touchEnd);
        rd.removeEventListener('touchcancel', observers._touchEnd);
      }
      if (observers._resize) {
        removeEventListener('resize', observers._resize);
        removeEventListener('orientationchange', observers._resize);
      }
      if (observers._vv && window.visualViewport) {
        visualViewport.removeEventListener('resize', observers._vv);
      }
      // limpiar estilos forzados del contenedor
      try { rd.style.width = ''; rd.style.height = ''; } catch (_) {}
      for (const i of [...urls.keys()]) drop(i);
      document.onkeydown = null;
      document.body.style.overflow = '';
      document.querySelector('.mosaic')?.remove();
      rd.remove();
    };
  };
  let unmount = mount();
  return () => { unmount(); Promise.resolve(zr.close()).catch(() => {}); };
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
