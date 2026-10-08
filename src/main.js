import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import * as zip from '@zip.js/zip.js';

const apiId = Number(import.meta.env.VITE_API_ID);
const apiHash = import.meta.env.VITE_API_HASH;
zip.configure({ useWebWorkers: false });

// ---------- Convención de tgstorage ----------
// "Batman:DC::Comics::tgstorage" -> título "Batman", grupo "DC", categoría "Comics"
const SEPARATOR = '::';
const TITLE_SEPARATOR = ':';
const FOLDER_POSTFIX = SEPARATOR + 'tgstorage';
const LIBRARY = 'comics';
const MB = 1024 * 1024;

function parseFolder(title) {
  if (!title.endsWith(FOLDER_POSTFIX)) return null;
  const [full, category = ''] = title.slice(0, -FOLDER_POSTFIX.length).split(SEPARATOR);
  const [name, group = ''] = full.split(TITLE_SEPARATOR);
  return { name, group: group || 'Sin editorial', category };
}

// Mismos tamaños de trozo que usa tgstorage (todos dividen 1 MB y son múltiplos de 4 KB)
const partSize = (size) => (size <= 100 * MB ? 128 : size <= 750 * MB ? 256 : 512) * 1024;

const app = document.getElementById('app');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
const fsBtn = document.getElementById('fs');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
let client;
let cleanup = null;
const stack = [];

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (k < items.length) { const j = k++; out[j] = await fn(items[j]); }
  }));
  return out;
}

// ---------- Telegram ----------
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

// Como tgstorage: búsqueda por "::tgstorage" (cubre también archivados) + recorrido completo de diálogos
async function loadLibrary() {
  const found = new Map();
  const add = (ch) => {
    if (ch?.className !== 'Channel') return;
    const info = parseFolder(ch.title || '');
    if (info && info.category.toLowerCase() === LIBRARY) found.set(String(ch.id), { ...info, entity: ch });
  };
  try {
    const res = await client.invoke(new Api.contacts.Search({ q: FOLDER_POSTFIX, limit: 100 }));
    res.chats.forEach(add);
  } catch (e) { console.warn('contacts.search falló', e); }
  for await (const d of client.iterDialogs({})) add(d.entity);
  return [...found.values()];
}

async function listComics(entity) {
  const out = [];
  const filter = new Api.InputMessagesFilterDocument();
  for await (const m of client.iterMessages(entity, { filter, limit: 100000 })) {
    const doc = m.document;
    const name = doc?.attributes?.find((a) => a.className === 'DocumentAttributeFilename')?.fileName;
    if (!name || !/\.cb[zr]$/i.test(name)) continue;
    out.push({ id: m.id, name, size: Number(doc.size.toString()), msg: m });
  }
  return out.sort((a, b) => natural(a.name, b.name));
}

// Reader de zip.js: pide a Telegram solo los trozos necesarios (en paralelo, con caché LRU)
class TgReader extends zip.Reader {
  constructor(msg, size) {
    super();
    this.msg = msg; this.size = size;
    this.ch = partSize(size);
    this.max = Math.max(8, Math.floor((48 * MB) / this.ch));
    this.cache = new Map();
  }
  chunk(i) {
    let p = this.cache.get(i);
    if (p) { this.cache.delete(i); this.cache.set(i, p); return p; }
    p = (async () => {
      const it = client.iterDownload({
        file: this.msg.media, offset: bigInt(i * this.ch), requestSize: this.ch, limit: 1, fileSize: bigInt(this.size),
      });
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
    const first = Math.floor(offset / this.ch);
    const last = Math.floor((end - 1) / this.ch);
    const idx = Array.from({ length: last - first + 1 }, (_, k) => first + k);
    const chunks = await mapLimit(idx, 6, (i) => this.chunk(i));
    const out = new Uint8Array(end - offset);
    idx.forEach((i, k) => {
      const c = chunks[k];
      const s = Math.max(offset, i * this.ch);
      const e = Math.min(end, i * this.ch + c.length);
      if (e > s) out.set(c.subarray(s - i * this.ch, e - i * this.ch), s - offset);
    });
    return out;
  }
}

// ---------- Navegación ----------
function go(title, render) { stack.push({ title, render }); show(); }
function show() {
  cleanup?.(); cleanup = null;
  const { title, render } = stack[stack.length - 1];
  titleEl.textContent = title;
  backBtn.hidden = stack.length < 2;
  fsBtn.hidden = true;
  document.onkeydown = null;
  render();
}
backBtn.onclick = () => { stack.pop(); show(); };
fsBtn.onclick = () => document.documentElement.requestFullscreen?.();

function list(items) {
  const ul = document.createElement('ul');
  for (const [label, hint, fn] of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = label;
    if (hint) { const s = document.createElement('small'); s.textContent = hint; b.append(s); }
    b.onclick = fn;
    li.append(b);
    ul.append(li);
  }
  app.replaceChildren(ul);
}
const msg = (t) => { const p = document.createElement('p'); p.textContent = t; app.replaceChildren(p); };

function groups(lib) {
  const gs = [...new Set(lib.map((c) => c.group))].sort(natural);
  list(gs.map((g) => [g, `${lib.filter((c) => c.group === g).length}`, () => channels(lib, g)]));
}
function channels(lib, g) {
  const chs = lib.filter((c) => c.group === g).sort((a, b) => natural(a.name, b.name));
  go(g, () => list(chs.map((c) => [c.name, '', () => files(c)])));
}
function files(ch) {
  go(ch.name, async () => {
    msg('Cargando…');
    try {
      const comics = await listComics(ch.entity);
      if (!comics.length) return msg('No hay archivos CBZ/CBR en este canal.');
      list(comics.map((c) => [c.name, `${Math.round(c.size / MB)} MB`, () => open(c)]));
    } catch (e) { msg('Error: ' + e.message); }
  });
}

// ---------- Lector ----------
function open(c) {
  go(c.name, async () => {
    if (/\.cbr$/i.test(c.name)) return msg('CBR todavía no soportado en esta versión de prueba.');
    msg('Leyendo índice del archivo…');
    const t0 = performance.now();
    try {
      const zr = new zip.ZipReader(new TgReader(c.msg, c.size));
      const pages = (await zr.getEntries())
        .filter((e) => !e.directory && /\.(jpe?g|png|webp|gif|avif)$/i.test(e.filename))
        .sort((a, b) => natural(a.filename, b.filename));
      if (!pages.length) return msg('No se encontraron imágenes.');
      console.log(`Índice leído en ${Math.round(performance.now() - t0)} ms (${pages.length} páginas)`);
      reader(c, pages, zr);
    } catch (e) { msg('Error: ' + e.message); }
  });
}

function reader(c, pages, zr) {
  const key = 'page:' + c.id;
  let n = Math.min(Number(localStorage.getItem(key) || 0), pages.length - 1);
  let token = 0;
  const urls = new Map(); // índice -> Promise<url>

  const wrap = document.createElement('div');
  wrap.id = 'viewer';
  const img = document.createElement('img');
  const bar = document.createElement('div');
  bar.className = 'bar';
  const zoomBtn = document.createElement('button');
  zoomBtn.textContent = 'Zoom';
  zoomBtn.onclick = () => wrap.classList.toggle('zoom');
  wrap.append(img, bar, zoomBtn);
  app.replaceChildren(wrap);
  fsBtn.hidden = false;

  const load = (i) => {
    if (i < 0 || i >= pages.length) return null;
    if (!urls.has(i)) {
      const p = pages[i].getData(new zip.BlobWriter(zip.getMimeType(pages[i].filename))).then((b) => URL.createObjectURL(b));
      p.catch(() => urls.delete(i));
      urls.set(i, p);
    }
    return urls.get(i);
  };
  const trim = () => {
    for (const [i, p] of urls) if (Math.abs(i - n) > 2) { urls.delete(i); p.then((u) => URL.revokeObjectURL(u), () => {}); }
  };

  async function showPage(i) {
    const t = Math.max(0, Math.min(pages.length - 1, i));
    if (t === n && img.src) return;
    n = t;
    localStorage.setItem(key, n);
    bar.textContent = `${n + 1} / ${pages.length}`;
    const mine = ++token;
    const t0 = performance.now();
    try {
      const url = await load(n);
      if (mine !== token) return;
      img.src = url;
      window.scrollTo(0, 0);
      console.log(`Página ${n + 1} en ${Math.round(performance.now() - t0)} ms`);
      trim();
      load(n + 1); // precarga la siguiente
    } catch (e) { bar.textContent = 'Error: ' + e.message; }
  }

  img.onclick = (e) => {
    if (wrap.classList.contains('zoom')) return;
    const r = img.getBoundingClientRect();
    showPage(e.clientX - r.left < r.width / 2 ? n - 1 : n + 1);
  };
  let sx = null, sy = 0;
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } else sx = null;
  }, { passive: true });
  wrap.addEventListener('touchend', (e) => {
    if (sx === null || (window.visualViewport?.scale || 1) > 1.05 || wrap.classList.contains('zoom')) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) showPage(dx < 0 ? n + 1 : n - 1);
  }, { passive: true });
  document.onkeydown = (e) => {
    if (e.key === 'ArrowRight') showPage(n + 1);
    if (e.key === 'ArrowLeft') showPage(n - 1);
    if (e.key === 'z') wrap.classList.toggle('zoom');
  };
  cleanup = () => {
    for (const p of urls.values()) p.then((u) => URL.revokeObjectURL(u), () => {});
    urls.clear();
    zr.close().catch(() => {});
  };
  showPage(n);
}

// ---------- Inicio ----------
(async () => {
  if (!apiId || !apiHash) return msg('Faltan VITE_API_ID y VITE_API_HASH.');
  try {
    await connect();
    msg('Buscando canales…');
    const lib = await loadLibrary();
    if (!lib.length) return msg('No se encontraron canales ...::Comics::tgstorage.');
    go('Cómics', () => groups(lib));
  } catch (e) { msg('Error: ' + e.message); }
})();
