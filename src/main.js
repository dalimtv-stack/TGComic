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
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const stripExt = (n) => n.replace(/\.cb[zr]$/i, '');
const pageKey = (id) => 'page:' + id;
const pagesKey = (id) => 'pages:' + id;
const sizeLabel = (f) => {
  const mb = `${Math.round(f.size / MB)} MB`;
  const tot = +localStorage.getItem(pagesKey(f.id));
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
const readProgress = (id) => {
  const cur = +localStorage.getItem(pageKey(id));
  const tot = +localStorage.getItem(pagesKey(id));
  if (!tot || tot < 1 || !cur && cur !== 0) return null;
  if (cur <= 0) return null;
  return { cur: cur + 1, tot, pct: Math.min(100, Math.round(((cur + 1) / tot) * 100)) };
};

// Nombre limpio: sin extensión, guiones bajos, etiquetas [..] (..) ni marcas @sitio
const clean = (n) => stripExt(n).replace(/_/g, ' ').replace(/\s*[(\[][^)\]]*[)\]]/g, '').replace(/\s*@\S+/g, '').replace(/\s+/g, ' ').trim();
// Número final del nombre: "#13", "Nº 5", "Vol. 2", "01 de 12", "07"...
const NUM = /[\s._-]*(?:#|n[º°]\.?|no\.|vol\.?|cap\.?|issue|núm\.?|parte|part|tomo)?\s*\d+(?:\.\d+)?(?:\s*(?:de|of)\s*\d+)?\s*$/i;
// Agrupa por serie: "Batman - The Long Halloween #01", "#13" -> serie; los especiales sin número que empiezan igual se unen
function groupSeries(files) {
  const by = new Map(), loose = [];
  for (const f of files) {
    const c = clean(f.name), b = c.replace(NUM, '').replace(/[\s._-]+$/, '');
    if (b && b !== c) { const k = b.toLowerCase(); (by.get(k) || by.set(k, { label: b, files: [] }).get(k)).files.push(f); }
    else loose.push([f, c]);
  }
  const groups = [...by.values()], rest = [];
  for (const [f, c] of loose) {
    const cl = c.toLowerCase();
    const g = groups.filter((x) => { const l = x.label.toLowerCase(); return cl.startsWith(l) && !/[\p{L}\d]/u.test(cl[l.length] || ' '); })
      .sort((x, y) => y.label.length - x.label.length)[0];
    if (g) g.files.push(f); else rest.push({ label: c, files: [f] });
  }
  return [...groups, ...rest]
    .map((g) => ({ label: g.label, files: g.files.sort((x, y) => natural(clean(x.name), clean(y.name))) }))
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
  return { get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined), set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => {}) };
})();

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
async function thumbFromBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const w = 320, h = Math.round((bmp.height * w) / bmp.width);
  const cv = el('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.8));
}
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
  b._label = () => (b.textContent = pref('mode', 'page') === 'page' ? '▯ Página' : '☰ Vertical');
  b.onclick = () => { setPref('mode', pref('mode', 'page') === 'page' ? 'vertical' : 'page'); b._label(); after?.(); };
  b._label();
  return b;
}
const hdrMode = modeBtn();
actions.append(hdrMode);
let cleanup = null, LIB = [], synced = false;

function go(title, render) { stack.push({ title, render }); history.pushState(null, ''); show(); }
function show() {
  cleanup?.(); cleanup = null;
  const e = stack[stack.length - 1];
  titleEl.textContent = e.title;
  backBtn.hidden = stack.length < 2;
  $('#top')?.classList.toggle('home', stack.length < 2);
  hdrMode._label();
  e.render(e);
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
const reg = (kind, files) => { for (const [p, url] of Object.entries(files)) ART[kind][decodeURIComponent(p.split('/').pop()).replace(/\.\w+$/, '').trim().toLowerCase()] = url; };
reg('groups', import.meta.glob(['/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}', '/src/groups/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}'], { eager: true, query: '?url', import: 'default' }));
reg('channels', import.meta.glob(['/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}', '/src/channels/*.{jpg,jpeg,png,webp,avif,gif,JPG,JPEG,PNG,WEBP}'], { eager: true, query: '?url', import: 'default' }));
function art(kind, name) {
  const d = el('div', 'cover'), ltr = el('span', '', name.slice(0, 1).toUpperCase());
  d.append(ltr);
  const img = new Image(), exts = ['jpg', 'jpeg', 'png', 'webp', 'JPG', 'PNG'];
  let k = -1;
  const next = () => { img.src = k < 0 && ART[kind][name.toLowerCase()] ? ART[kind][name.toLowerCase()] : (++k < exts.length ? `/${kind}/${encodeURIComponent(name)}.${exts[k]}` : ''); if (k < 0) k = -0.5; };
  img.onload = () => { ltr.remove(); d.append(img); };
  img.onerror = () => { if (k < exts.length) next(); };
  next();
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
  const prog = series ? null : readProgress(f.id);
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
function grid(items, withSearch) {
  const g = el('div', 'grid'), nodes = [];
  const draw = (q = '') => g.replaceChildren(...items.filter((i) => i.label.toLowerCase().includes(q)).map((i) => {
    const c = el('div', 'card'), hit = el('button', 'hit'), name = el('div', 'name'), t = el('b', '', i.label);
    hit.append(i.cover());
    // Portada: abrir cómic / serie. Título: menú de opciones si existe, si no también abre.
    hit.onclick = i.go;
    if (i.menu) {
      t.classList.add('has-menu');
      t.onclick = (ev) => { ev.stopPropagation(); i.menu(); };
      t.title = 'Opciones';
      t.setAttribute('role', 'button');
      t.setAttribute('aria-label', 'Opciones de ' + i.label);
    } else {
      t.onclick = i.go;
    }
    name.append(t);
    c.append(hit, name);
    if (i.sub) c.append(el('small', '', i.sub));
    return c;
  }));
  if (withSearch) { const s = el('input'); s.id = 'search'; s.type = 'search'; s.placeholder = 'Buscar…'; s.oninput = () => draw(s.value.toLowerCase().trim()); nodes.push(s); }
  nodes.push(g);
  app.replaceChildren(...nodes);
  draw();
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
const ungrouped = (ch) => new Set(JSON.parse(localStorage.getItem(ugKey(ch)) || '[]'));
function setUngrouped(ch, label, on, after) {
  const u = ungrouped(ch);
  on ? u.add(label.toLowerCase()) : u.delete(label.toLowerCase());
  localStorage.setItem(ugKey(ch), JSON.stringify([...u]));
  after();
}

function cardNode(i) {
  const c = el('div', 'card'), hit = el('button', 'hit'), name = el('div', 'name'), t = el('b', '', i.label);
  hit.append(i.cover());
  hit.onclick = i.go;
  if (i.menu) {
    t.classList.add('has-menu');
    t.onclick = (ev) => { ev.stopPropagation(); i.menu(); };
    t.title = 'Opciones';
    t.setAttribute('role', 'button');
  } else t.onclick = i.go;
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
    sec.append(el('div', 'sec-title', 'Siguiendo'));
    const row = el('div', 'continue-row');
    const ch = last.ch, f = last.f;
    const prog = readProgress(f.id);
    row.append(cardNode({
      label: clean(f.name),
      sub: prog ? `${prog.cur} / ${prog.tot} · ${prog.pct}%` : sizeLabel(f),
      cover: () => comicCover(ch, f),
      go: () => openComic(ch, f),
    }));
    sec.append(row);
    nodes.push(sec);
    nodes.push(el('div', 'sec-sep'));
  }
  nodes.push(el('div', 'sec-title', 'Editoriales'));
  const gs = [...new Set(LIB.map((c) => c.group))].sort(natural);
  const g = el('div', 'grid');
  for (const name of gs) {
    const n = LIB.filter((c) => c.group === name).length;
    g.append(cardNode({
      label: name,
      sub: n === 1 ? '1 canal' : `${n} canales`,
      cover: () => art('groups', name),
      go: () => channelsView(name),
    }));
  }
  nodes.push(g);
  app.replaceChildren(...nodes);
}
function channelsView(g) {
  go(g, async (e) => {
    const chs = LIB.filter((c) => c.group === g).sort((a, b) => natural(a.name, b.name));
    const build = async () => {
      const items = [];
      for (const ch of chs) {
        const files = (await kv.get('f:' + ch.id)) || [];
        const n = files.length;
        items.push({
          label: ch.name,
          sub: n ? (n === 1 ? '1 cómic' : `${n} cómics`) : '',
          cover: () => art('channels', ch.name),
          go: () => filesView(ch),
        });
      }
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
  go(ch.name, async (e) => {
    let cur = [];
    const single = (f) => ({ label: clean(f.name), sub: sizeLabel(f), cover: () => comicCover(ch, f), go: () => openComic(ch, f) });
    const draw = (files) => {
      if (!alive(e)) return;
      cur = files;
      if (!files.length) return msg('No hay archivos CBZ/CBR en este canal.');
      const un = ungrouped(ch), items = [], redraw = () => draw(cur);
      for (const { label, files: fs } of groupSeries(files)) {
        if (fs.length === 1) items.push(single(fs[0]));
        else if (un.has(label.toLowerCase())) fs.forEach((f) => items.push({ ...single(f), menu: () => sheet(label, [['Volver a agrupar la serie', () => setUngrouped(ch, label, false, redraw)]]) }));
        else items.push({ label, sub: `${fs.length} números`, cover: () => comicCover(ch, fs[0], fs.length, true), go: () => seriesView(ch, label, fs), menu: () => sheet(label, [['Desagrupar serie', () => setUngrouped(ch, label, true, redraw)]]) });
      }
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
  go(s, () => grid(files.map((f) => ({
    label: (() => { const r = clean(f.name).slice(s.length).replace(/^[\s#._-]+/, ''); return /^\d/.test(r) ? '#' + r : r || clean(f.name); })(),
    sub: sizeLabel(f), cover: () => comicCover(ch, f), go: () => openComic(ch, f),
  })), true));
}

// ---------- Lector ----------
function openComic(ch, f) {
  go(stripExt(f.name), async (e) => {
    reading = true;
    const ac = { cancelled: false };
    let rdClean = null;
    cleanup = () => { ac.cancelled = true; reading = false; pump(); rdClean?.(); };
    msg('Abriendo…');
    try {
      setLastRead(ch, f);
      const status = (t) => { if (!cancelled(ac) && alive(e)) msg(t); };
      const arc = await openPages(await getMsg(ch, f), f.size, status, ac);
      if (cancelled(ac) || !alive(e)) { try { arc.close(); } catch (_) {} return; }
      if (!arc.pages.length) return msg('No se encontraron imágenes.');
      // Guardar miniatura de portada (útil sobre todo en CBR)
      pageBlob(arc.pages[0]).then((b) => saveCoverBlob(ch, f, b)).catch(() => {});
      rdClean = reader(f, arc.pages, arc);
    } catch (err) {
      if (err?.cancelled || cancelled(ac)) return;
      if (alive(e)) msg('Error: ' + err.message);
    }
  });
}

function reader(f, pages, zr) {
  const key = pageKey(f.id);
  try { localStorage.setItem(pagesKey(f.id), String(pages.length)); } catch (_) {}
  let n = Math.min(+localStorage.getItem(key) || 0, pages.length - 1);
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

  const mount = () => {
    const vert = pref('mode', 'page') === 'vertical';
    let token = 0, observers = [];
    const rd = el('div'); rd.id = 'rd';
    const top = el('div', 'bar'), back = el('button', 'btn', '‹'), cnt = el('span', 'cnt');
    back.onclick = () => history.back();
    const mb = modeBtn(() => { unmount(); unmount = mount(); });
    top.append(back, el('span', 'ttl', stripExt(f.name)), mb, cnt);
    document.body.append(rd);
    document.body.style.overflow = 'hidden';
    const setCount = () => (cnt.textContent = `${n + 1} / ${pages.length}`);
    const uiTimer = setTimeout(() => rd.classList.add('ui-off'), 2500);

    if (!vert) {
      rd.className = 'page fit-' + pref('fit', 'screen');
      const fit = el('button', 'btn');
      let img = el('img');
      const fitLabel = () => (fit.textContent = pref('fit', 'screen') === 'screen' ? '↔ Ancho' : '⤢ Pantalla');
      fit.onclick = () => { setPref('fit', pref('fit', 'screen') === 'screen' ? 'width' : 'screen'); rd.className = rd.className.replace(/fit-\w+/, 'fit-' + pref('fit', 'screen')); fitLabel(); };
      fitLabel();
      top.insertBefore(fit, mb);
      img.draggable = false;
      const eL = el('div', 'edge l'), eR = el('div', 'edge r');
      rd.append(img, eL, eR, top);
      const turn = async (i) => {
        const t = Math.max(0, Math.min(pages.length - 1, i));
        if (t === n && img.src) return;
        n = t; localStorage.setItem(key, n); setCount(); rd.classList.remove('zoom');
        const mine = ++token;
        try {
          const u = await load(n);
          if (mine !== token) return;
          const im = el('img'); im.draggable = false; im.src = u;
          await im.decode().catch(() => {});
          if (mine !== token) return;
          img.replaceWith(im); img = im; rd.scrollTo(0, 0);
          for (const i2 of [...urls.keys()]) if (i2 < n - 2 || i2 > n + 4) drop(i2);
          for (const k of [1, 2, 3]) { if (token !== mine) return; await Promise.resolve(load(n + k)).catch(() => {}); } // precarga
        } catch (err) { cnt.textContent = 'Error'; console.error(err); }
      };
      eL.onclick = () => turn(n - 1);
      eR.onclick = () => turn(n + 1);
      let last = 0, tapT;
      rd.onclick = (ev) => {
        if (ev.target.tagName !== 'IMG') return;
        const t = Date.now();
        if (t - last < 300) { clearTimeout(tapT); last = 0; rd.classList.toggle('zoom'); }
        else { last = t; tapT = setTimeout(() => rd.classList.toggle('ui-off'), 300); }
      };
      let sx = null, sy = 0;
      rd.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } else sx = null; }, { passive: true });
      rd.addEventListener('touchend', (e) => {
        if (sx === null || (window.visualViewport?.scale || 1) > 1.05 || rd.classList.contains('zoom')) return;
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
        sx = null;
        if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) turn(dx < 0 ? n + 1 : n - 1);
      }, { passive: true });
      document.onkeydown = (e) => { if (e.key === 'ArrowRight') turn(n + 1); if (e.key === 'ArrowLeft') turn(n - 1); };
      turn(n);
    } else {
      rd.className = 'vert';
      // Altura fija por slot una vez medida → evita saltos de scroll
      const slots = pages.map((_, i) => {
        const d = el('div', 'slot');
        d.dataset.i = i;
        d.style.overflowAnchor = 'none';
        return d;
      });
      rd.append(...slots, top);
      const loaded = new Map();
      const fixedH = new Map();
      const place = (slot, im, i) => {
        slot.replaceChildren(im);
        // fijar altura según ratio natural y ancho real del slot
        const w = slot.clientWidth || rd.clientWidth || window.innerWidth;
        if (im.naturalWidth && im.naturalHeight) {
          const h = Math.round(w * (im.naturalHeight / im.naturalWidth));
          fixedH.set(i, h);
          slot.style.minHeight = h + 'px';
          slot.style.height = h + 'px';
        }
      };
      const loadIO = new IntersectionObserver((es) => es.forEach(async (x) => {
        const i = +x.target.dataset.i;
        if (!x.isIntersecting || loaded.has(i)) return;
        loaded.set(i, true);
        try {
          const im = el('img');
          im.decoding = 'async';
          im.src = await load(i);
          await im.decode().catch(() => {});
          if (!x.target.isConnected) return;
          place(x.target, im, i);
        } catch (err) { loaded.delete(i); }
      }), { root: rd, rootMargin: '180% 0px' });
      const curIO = new IntersectionObserver((es) => es.forEach((x) => {
        if (!x.isIntersecting) return;
        n = +x.target.dataset.i;
        localStorage.setItem(key, n);
        setCount();
        // Liberar lejos; conservar altura fija para no desplazar el scroll
        for (const i of [...loaded.keys()]) {
          if (Math.abs(i - n) <= 15) continue;
          const s = slots[i];
          if (fixedH.has(i)) {
            s.style.minHeight = fixedH.get(i) + 'px';
            s.style.height = fixedH.get(i) + 'px';
          }
          s.replaceChildren();
          loaded.delete(i);
          drop(i);
        }
      }), { root: rd, rootMargin: '-40% 0px -40% 0px' });
      slots.forEach((s) => { loadIO.observe(s); curIO.observe(s); });
      observers = [loadIO, curIO];
      rd.onclick = () => rd.classList.toggle('ui-off');
      // restaurar posición sin animación brusca
      requestAnimationFrame(() => {
        const s = slots[n];
        if (s) rd.scrollTop = s.offsetTop;
      });
    }
    setCount();
    return () => {
      clearTimeout(uiTimer);
      observers.forEach((o) => o.disconnect());
      for (const i of [...urls.keys()]) drop(i);
      document.onkeydown = null;
      document.body.style.overflow = '';
      rd.remove();
    };
  };
  let unmount = mount();
  return () => { unmount(); Promise.resolve(zr.close()).catch(() => {}); };
}

// ---------- Inicio ----------
(async () => {
  if (!apiId || !apiHash) return msg('Faltan VITE_API_ID y VITE_API_HASH.');
  LIB = (await kv.get('lib')) || [];
  stack.push({ title: 'Cómics', render: groupsView });
  show();
  ready = connect();
  ready.catch((e) => msg('Error de conexión: ' + e.message));
  ready.then(refreshLibrary).then((lib) => {
    const changed = JSON.stringify(lib) !== JSON.stringify(LIB);
    LIB = lib; synced = true;
    if ((changed || !lib.length) && stack.length === 1) show();
  }).catch((e) => console.error(e));
})();
