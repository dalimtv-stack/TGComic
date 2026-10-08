import './style.css';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import * as zip from '@zip.js/zip.js';

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
// "Batman - silencio #01.cbz" -> "Batman - silencio"
const seriesOf = (n) => stripExt(n).replace(/[\s._-]*(?:#|n[º°o]\.?|vol\.?|v)?\s*\d+(?:\.\d+)?(?:\s*[(\[][^)\]]*[)\]])*\s*$/i, '').trim() || stripExt(n);
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
      const it = client.iterDownload({ file: this.msg.media, offset: bigInt(i * this.ch), requestSize: this.ch, limit: 1, fileSize: bigInt(this.size) });
      for await (const c of it) return new Uint8Array(c);
      return new Uint8Array(0);
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

// ---------- Portadas (primera imagen del CBZ, miniatura cacheada) ----------
const cq = []; let crun = 0, reading = false;
const enqueue = (fn) => new Promise((res) => { cq.push(() => fn().then(res, () => res(null))); pump(); });
function pump() { if (reading) return; while (crun < 2 && cq.length) { crun++; cq.shift()().finally(() => { crun--; pump(); }); } }

async function getCover(ch, f) {
  const key = `c:${ch.id}:${f.id}`;
  let b = await kv.get(key);
  if (!b && /\.cbz$/i.test(f.name)) b = await enqueue(() => makeCover(ch, f, key));
  return b;
}
async function makeCover(ch, f, key) {
  const zr = new zip.ZipReader(new TgReader(await getMsg(ch, f), f.size));
  try {
    const first = pagesOf(await zr.getEntries())[0];
    const bmp = await createImageBitmap(await first.getData(new zip.BlobWriter(zip.getMimeType(first.filename))));
    const w = 320, h = Math.round((bmp.height * w) / bmp.width);
    const cv = el('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.8));
    await kv.set(key, out);
    return out;
  } finally { zr.close().catch(() => {}); }
}
const io = new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { io.unobserve(x.target); x.target._load?.(); } }), { rootMargin: '400px' });

// ---------- Navegación y vistas ----------
const app = $('#app'), titleEl = $('#title'), backBtn = $('#back'), actions = $('#actions');
const stack = [];
let cleanup = null, LIB = [], synced = false;

function go(title, render) { stack.push({ title, render }); history.pushState(null, ''); show(); }
function show() {
  cleanup?.(); cleanup = null;
  const e = stack[stack.length - 1];
  titleEl.textContent = e.title;
  backBtn.hidden = stack.length < 2;
  actions.replaceChildren();
  e.render(e);
}
backBtn.onclick = () => history.back();
addEventListener('popstate', () => { if (stack.length > 1) { stack.pop(); show(); } });
const msg = (t) => app.replaceChildren(el('div', 'msg', t));
const alive = (e) => stack[stack.length - 1] === e;

function art(kind, name) {
  const d = el('div', 'cover'), ltr = el('span', '', name.slice(0, 1).toUpperCase());
  d.append(ltr);
  const img = new Image(), exts = ['jpg', 'png', 'webp'];
  let k = 0;
  const src = () => `/${kind}/${encodeURIComponent(name)}.${exts[k]}`;
  img.onload = () => { ltr.remove(); d.append(img); };
  img.onerror = () => { if (++k < exts.length) img.src = src(); };
  img.src = src();
  return d;
}
function comicCover(ch, f, badge) {
  const d = el('div', 'cover'), ltr = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
  d.append(ltr);
  if (badge) d.append(el('span', 'badge', badge));
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
    const b = el('button', 'card');
    b.append(i.cover(), el('b', '', i.label));
    if (i.sub) b.append(el('small', '', i.sub));
    b.onclick = i.go;
    return b;
  }));
  if (withSearch) { const s = el('input'); s.id = 'search'; s.type = 'search'; s.placeholder = 'Buscar…'; s.oninput = () => draw(s.value.toLowerCase().trim()); nodes.push(s); }
  nodes.push(g);
  app.replaceChildren(...nodes);
  draw();
}

function groupsView() {
  const b = el('button', 'btn');
  const label = () => (b.textContent = pref('mode', 'page') === 'page' ? '▯ Página a página' : '☰ Vertical');
  b.onclick = () => { setPref('mode', pref('mode', 'page') === 'page' ? 'vertical' : 'page'); label(); };
  label();
  actions.append(b);
  if (!LIB.length) return msg(synced ? 'No se encontraron canales ...::Comics::tgstorage.' : 'Conectando…');
  const gs = [...new Set(LIB.map((c) => c.group))].sort(natural);
  grid(gs.map((g) => ({ label: g, sub: `${LIB.filter((c) => c.group === g).length} canales`, cover: () => art('groups', g), go: () => channelsView(g) })));
}
function channelsView(g) {
  go(g, () => grid(LIB.filter((c) => c.group === g).sort((a, b) => natural(a.name, b.name)).map((ch) => ({ label: ch.name, cover: () => art('channels', ch.name), go: () => filesView(ch) })), true));
}
function filesView(ch) {
  go(ch.name, async (e) => {
    const draw = (files) => {
      if (!alive(e)) return;
      if (!files.length) return msg('No hay archivos CBZ/CBR en este canal.');
      const by = new Map();
      for (const f of files) { const s = seriesOf(f.name); (by.get(s) || by.set(s, []).get(s)).push(f); }
      grid([...by].sort((a, b) => natural(a[0], b[0])).map(([s, fs]) => fs.length === 1
        ? { label: stripExt(fs[0].name), sub: `${Math.round(fs[0].size / MB)} MB`, cover: () => comicCover(ch, fs[0]), go: () => openComic(ch, fs[0]) }
        : { label: s, sub: `${fs.length} números`, cover: () => comicCover(ch, fs[0], fs.length), go: () => seriesView(ch, s, fs) }), true);
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
    label: stripExt(f.name).slice(s.length).replace(/^[\s._-]+/, '') || stripExt(f.name),
    sub: `${Math.round(f.size / MB)} MB`, cover: () => comicCover(ch, f), go: () => openComic(ch, f),
  })), true));
}

// ---------- Lector ----------
function openComic(ch, f) {
  go(stripExt(f.name), async (e) => {
    reading = true;
    let rdClean = null;
    cleanup = () => { reading = false; pump(); rdClean?.(); };
    if (/\.cbr$/i.test(f.name)) return msg('CBR todavía no está soportado.');
    msg('Abriendo…');
    try {
      const zr = new zip.ZipReader(new TgReader(await getMsg(ch, f), f.size));
      const pages = pagesOf(await zr.getEntries());
      if (!alive(e)) return zr.close();
      if (!pages.length) return msg('No se encontraron imágenes.');
      rdClean = reader(f, pages, zr);
    } catch (err) { msg('Error: ' + err.message); }
  });
}

function reader(f, pages, zr) {
  const key = 'page:' + f.id, vert = pref('mode', 'page') === 'vertical';
  let n = Math.min(+localStorage.getItem(key) || 0, pages.length - 1), token = 0, uiTimer;
  const urls = new Map();
  const load = (i) => {
    if (i < 0 || i >= pages.length) return null;
    if (!urls.has(i)) {
      const p = pages[i].getData(new zip.BlobWriter(zip.getMimeType(pages[i].filename))).then((b) => URL.createObjectURL(b));
      p.catch(() => urls.delete(i));
      urls.set(i, p);
    }
    return urls.get(i);
  };
  const drop = (i) => { urls.get(i)?.then((u) => URL.revokeObjectURL(u), () => {}); urls.delete(i); };

  const rd = el('div'); rd.id = 'rd';
  const top = el('div', 'bar'), back = el('button', 'btn', '‹'), cnt = el('span', 'cnt');
  back.onclick = () => history.back();
  top.append(back, el('span', 'ttl', stripExt(f.name)), cnt);
  document.body.append(rd);
  document.body.style.overflow = 'hidden';
  const setCount = () => (cnt.textContent = `${n + 1} / ${pages.length}`);
  const hideUi = () => rd.classList.add('ui-off');
  uiTimer = setTimeout(hideUi, 2500);
  let observers = [];

  if (!vert) {
    rd.className = 'page fit-' + pref('fit', 'screen');
    const fit = el('button', 'btn'), img = el('img');
    const fitLabel = () => (fit.textContent = pref('fit', 'screen') === 'screen' ? '↔ Ancho' : '⤢ Pantalla');
    fit.onclick = () => { setPref('fit', pref('fit', 'screen') === 'screen' ? 'width' : 'screen'); rd.className = rd.className.replace(/fit-\w+/, 'fit-' + pref('fit', 'screen')); fitLabel(); };
    fitLabel();
    top.insertBefore(fit, cnt);
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
        img.src = u; rd.scrollTo(0, 0);
        for (const i2 of [...urls.keys()]) if (i2 < n - 2 || i2 > n + 4) drop(i2);
        for (const k of [1, 2, 3]) { if (token !== mine) return; await Promise.resolve(load(n + k)).catch(() => {}); } // precarga en segundo plano
      } catch (err) { cnt.textContent = 'Error'; console.error(err); }
    };
    eL.onclick = () => turn(n - 1);
    eR.onclick = () => turn(n + 1);
    let last = 0, tapT;
    img.onclick = () => {
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
    const slots = pages.map((_, i) => { const d = el('div', 'slot'); d.dataset.i = i; return d; });
    rd.append(...slots, top);
    const loaded = new Map();
    const loadIO = new IntersectionObserver((es) => es.forEach(async (x) => {
      const i = +x.target.dataset.i;
      if (!x.isIntersecting || loaded.has(i)) return;
      loaded.set(i, true);
      try {
        const im = el('img'); im.src = await load(i);
        x.target.style.minHeight = '0'; x.target.replaceChildren(im);
      } catch (err) { loaded.delete(i); }
    }), { root: rd, rootMargin: '150% 0px' });
    const curIO = new IntersectionObserver((es) => es.forEach((x) => {
      if (!x.isIntersecting) return;
      n = +x.target.dataset.i; localStorage.setItem(key, n); setCount();
      for (const i of [...loaded.keys()]) if (Math.abs(i - n) > 8) { // libera páginas lejanas
        const s = slots[i]; s.style.minHeight = s.clientHeight + 'px'; s.replaceChildren(); loaded.delete(i); drop(i);
      }
    }), { root: rd, rootMargin: '-50% 0px -50% 0px' });
    slots.forEach((s) => { loadIO.observe(s); curIO.observe(s); });
    observers = [loadIO, curIO];
    rd.onclick = () => rd.classList.toggle('ui-off');
    slots[n].scrollIntoView();
    setCount();
  }
  setCount();
  return () => {
    clearTimeout(uiTimer);
    observers.forEach((o) => o.disconnect());
    for (const i of [...urls.keys()]) drop(i);
    document.onkeydown = null;
    document.body.style.overflow = '';
    rd.remove();
    zr.close().catch(() => {});
  };
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
