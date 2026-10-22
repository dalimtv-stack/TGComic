/**
 * Sincronización multi-dispositivo vía Supabase.
 * Usuario + contraseña → id = SHA-256(usuario), payload AES-GCM.
 * Subida exige verificador de contraseña en servidor (no se puede sobrescribir sin ella).
 * Sync principal: al cargar la app (antes de la biblioteca).
 */

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const SCHEMA = 1;
const LS_USER = 'sync:username';
const LS_PASS = 'sync:password';
const LS_META = 'sync:meta';
const LS_TS = 'sync:ts'; // marca de tiempo local (ms) de la última edición de cada clave de progreso

// Claves donde "gana el cambio más reciente" (no el valor mayor): permite volver atrás a propósito.
const TS_PREFIXES = ['page:', 'read:'];
const isTsKey = (k) => TS_PREFIXES.some((p) => k.startsWith(p));

function loadTs() {
  try { return JSON.parse(localStorage.getItem(LS_TS) || '{}') || {}; } catch { return {}; }
}

/** Llamar tras CADA escritura local de page:/read: (acción del usuario en este dispositivo). */
export function touchKey(k) {
  if (!k || !isTsKey(k)) return;
  try {
    const t = loadTs();
    t[k] = Date.now();
    localStorage.setItem(LS_TS, JSON.stringify(t));
  } catch (_) {}
}

const SYNC_PREFIXES = [
  'pref:',
  'page:',
  'pages:',
  'pagefmt:',
  'seriesName:',
  'comicName:',
  'comicSeries:',
  'ungroup:',
  'read:',
  'coverAdapt:', // portada personalizada: nº de página elegida + modo de recorte (sin imágenes)
];
const SYNC_KEYS = ['channelNames', 'groupNames', 'lastRead', 'recentReads', 'contentLocks'];

function configured() {
  return !!(SUPABASE_URL && SUPABASE_ANON);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function normalizeUser(u) {
  return String(u || '').trim().toLowerCase();
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verificador enviado al servidor (no es la contraseña en claro). */
async function passwordVerifier(username, password) {
  return sha256Hex('tgcomic-verifier:' + normalizeUser(username) + ':' + password);
}

async function userRowId(username) {
  return sha256Hex('tgcomic-user:' + normalizeUser(username));
}

const _keyCache = new Map();
async function deriveKey(username, password) {
  const ck = normalizeUser(username) + '\n' + password;
  if (_keyCache.has(ck)) return _keyCache.get(ck);
  const k = await _deriveKey(username, password);
  _keyCache.set(ck, k);
  return k;
}
async function _deriveKey(username, password) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const salt = enc.encode('tgcomic-sync-v1:' + normalizeUser(username));
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function b64encode(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function encryptPayload(username, password, obj) {
  const key = await deriveKey(username, password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return b64encode(iv) + ':' + b64encode(cipher);
}

async function decryptPayload(username, password, payload) {
  const [ivB64, dataB64] = String(payload || '').split(':');
  if (!ivB64 || !dataB64) throw new Error('Datos remotos inválidos');
  const key = await deriveKey(username, password);
  const iv = b64decode(ivB64);
  const data = b64decode(dataB64);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Contraseña incorrecta');
  }
}

async function rpc(name, body) {
  if (!configured()) throw new Error('Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON,
      Authorization: 'Bearer ' + SUPABASE_ANON,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const low = (t || '').toLowerCase();
    if (low.includes('invalid password') || low.includes('verifier')) {
      throw new Error('Contraseña incorrecta: no se pueden sobrescribir los datos remotos');
    }
    throw new Error('Supabase ' + res.status + (t ? ': ' + t.slice(0, 160) : ''));
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

async function getRemote(id) {
  const rows = await rpc('get_comic_sync', { p_id: id });
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0];
}

async function upsertRemote(id, payload, verifier) {
  await rpc('upsert_comic_sync', {
    p_id: id,
    p_payload: payload,
    p_schema_version: SCHEMA,
    p_verifier: verifier,
  });
}

export function collectSnapshot() {
  const data = { v: SCHEMA, keys: {}, ts: {} };
  const allTs = loadTs();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k === 'tg_session' || k.startsWith('sync:')) continue;
      const ok = SYNC_KEYS.includes(k) || SYNC_PREFIXES.some((p) => k.startsWith(p));
      if (!ok) continue;
      data.keys[k] = localStorage.getItem(k);
      if (isTsKey(k) && allTs[k]) data.ts[k] = allTs[k];
    }
  } catch (_) {}
  return data;
}

export function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  const keys = snap.keys && typeof snap.keys === 'object' ? snap.keys : {};
  try {
    for (const [k, v] of Object.entries(keys)) {
      if (!k || k === 'tg_session' || k.startsWith('sync:')) continue;
      const allowed = SYNC_KEYS.includes(k) || SYNC_PREFIXES.some((p) => k.startsWith(p));
      if (!allowed) continue;
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, String(v));
    }
  } catch (e) {
    console.warn('[sync] apply', e);
  }
}

/**
 * Fusiona snapshot remoto con el local.
 * - page: / read: → gana el cambio MÁS RECIENTE (marca de tiempo por clave), así se puede
 *   retroceder a propósito. Sin marcas (datos antiguos) → fallback: página mayor / leído si alguno
 * - pages: (total de páginas) → número mayor
 * - recentReads → unión por id de cómic (remoto primero)
 * - resto (prefs, nombres…) → remoto gana si existe; si no, se conserva local
 */
function mergeKeyMaps(localSnap, remoteSnap, opts = {}) {
  const preferLocal = !!opts.preferLocal;
  const lk = localSnap?.keys;
  const rk = remoteSnap?.keys;
  const local = lk && typeof lk === 'object' ? lk : {};
  const remote = rk && typeof rk === 'object' ? rk : {};
  const lts = localSnap?.ts && typeof localSnap.ts === 'object' ? localSnap.ts : {};
  const rts = remoteSnap?.ts && typeof remoteSnap.ts === 'object' ? remoteSnap.ts : {};
  const out = { ...local };
  const outTs = { ...lts };

  const mergeRecent = (a, b) => {
    let la = [], lb = [];
    try { la = JSON.parse(a || '[]'); } catch (_) {}
    try { lb = JSON.parse(b || '[]'); } catch (_) {}
    if (!Array.isArray(la)) la = [];
    if (!Array.isArray(lb)) lb = [];
    const byId = new Map();
    for (const item of [...la, ...lb]) {
      if (!item?.ch?.id || !item?.f?.id) continue;
      const id = String(item.ch.id) + ':' + String(item.f.id);
      const prev = byId.get(id);
      if (!prev || (Number(item.at) || 0) >= (Number(prev.at) || 0)) byId.set(id, item);
    }
    const res = [...byId.values()].sort((x, y) => (Number(y.at) || 0) - (Number(x.at) || 0));
    return JSON.stringify(res.slice(0, 12));
  };

  for (const [k, rv] of Object.entries(remote)) {
    if (!k) continue;
    const lv = out[k];
    if (lv == null || lv === '') {
      out[k] = rv;
      if (rts[k]) outTs[k] = rts[k];
      continue;
    }
    if (isTsKey(k)) {
      const lt = Number(lts[k]) || 0;
      const rt = Number(rts[k]) || 0;
      if (lt && rt) {
        // Ambos con marca: gana el más reciente (empate → local)
        if (rt > lt) { out[k] = rv; outTs[k] = rt; } else out[k] = lv;
      } else if (k.startsWith('page:')) {
        out[k] = String(Math.max(Number(lv) || 0, Number(rv) || 0));
        if (rt && !lt) outTs[k] = rt;
      } else {
        out[k] = (String(lv) === '1' || String(rv) === '1') ? '1' : String(rv);
        if (rt && !lt) outTs[k] = rt;
      }
    } else if (k.startsWith('pages:')) {
      out[k] = String(Math.max(Number(lv) || 0, Number(rv) || 0));
    } else if (k === 'recentReads') {
      out[k] = mergeRecent(lv, rv);
    } else if (k === 'lastRead') {
      try {
        const L = JSON.parse(lv || 'null');
        const R = JSON.parse(rv || 'null');
        const la = Number(L?.at) || 0;
        const ra = Number(R?.at) || 0;
        if (R?.ch?.id && (!L?.ch?.id || ra >= la)) out[k] = rv;
        else out[k] = lv;
      } catch (_) {
        out[k] = rv || lv;
      }
    } else if (k === 'contentLocks') {
      // Gana la versión con updatedAt más alto (no borrar locks de otro dispositivo)
      try {
        const L = JSON.parse(lv || '{}') || {};
        const R = JSON.parse(rv || '{}') || {};
        const la = Number(L.updatedAt) || 0;
        const ra = Number(R.updatedAt) || 0;
        if (ra > la) out[k] = rv;
        else if (la > ra) out[k] = lv;
        else {
          // Empate o sin marca: unión de listas (más seguro que perder un bloqueo)
          const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].map(String))];
          out[k] = JSON.stringify({
            groups: union(L.groups, R.groups),
            channels: union(L.channels, R.channels),
            series: union(L.series, R.series),
            comics: union(L.comics, R.comics),
            updatedAt: Math.max(la, ra, Date.now()),
          });
        }
      } catch (_) {
        out[k] = rv || lv;
      }
    } else {
      // prefs, renombres, etc.: al abrir gana la nube; al subir ganan los cambios locales
      out[k] = preferLocal ? lv : rv;
    }
  }
  return { keys: out, ts: outTs };
}

/** Aplica el resultado de mergeKeyMaps ({keys, ts}) a localStorage. */
function writeKeyMap(merged) {
  const keys = merged?.keys || {};
  try {
    const t = { ...loadTs(), ...(merged?.ts || {}) };
    localStorage.setItem(LS_TS, JSON.stringify(t));
  } catch (_) {}
  try {
    for (const [k, v] of Object.entries(keys)) {
      if (!k || k === 'tg_session' || k.startsWith('sync:')) continue;
      const allowed = SYNC_KEYS.includes(k) || SYNC_PREFIXES.some((p) => k.startsWith(p));
      if (!allowed) continue;
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, String(v));
    }
  } catch (e) {
    console.warn('[sync] write', e);
  }
}

export function isLoggedIn() {
  return !!(localStorage.getItem(LS_USER) && localStorage.getItem(LS_PASS));
}

export function currentUsername() {
  return localStorage.getItem(LS_USER) || '';
}

function saveSession(username, password) {
  localStorage.setItem(LS_USER, normalizeUser(username));
  localStorage.setItem(LS_PASS, password);
}

export function logout() {
  localStorage.removeItem(LS_USER);
  localStorage.removeItem(LS_PASS);
  localStorage.removeItem(LS_META);
  localStorage.removeItem(LS_TS);
}

/** Fecha en horario de España: hh:mm:ss DD/MM/AAAA */
export function formatSyncDate(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) return String(iso || '');
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false,
    }).formatToParts(d);
    const g = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${g('hour')}:${g('minute')}:${g('second')} ${g('day')}/${g('month')}/${g('year')}`;
  } catch {
    return String(iso || '');
  }
}

function formatSyncBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return x + ' B';
  if (x < 1024 * 1024) return (x / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
  return (x / (1024 * 1024)).toFixed(2).replace(/\.00$/, '') + ' MB';
}

/** Tamaño aproximado del snapshot local (datos que se sincronizan). */
export function snapshotByteSize() {
  try {
    const json = JSON.stringify(collectSnapshot());
    return new TextEncoder().encode(json).length;
  } catch {
    return 0;
  }
}

function setMeta(updatedAt, sizeBytes) {
  try {
    const prev = JSON.parse(localStorage.getItem(LS_META) || '{}') || {};
    const size = sizeBytes != null ? sizeBytes : (prev.sizeBytes ?? snapshotByteSize());
    localStorage.setItem(LS_META, JSON.stringify({
      updatedAt: updatedAt || new Date().toISOString(),
      sizeBytes: size,
    }));
  } catch (_) {}
}

/** Crear cuenta. Si el usuario ya existe → error. */
export async function register(username, password) {
  if (!configured()) throw new Error('Sincronización no configurada en el servidor');
  const u = normalizeUser(username);
  if (u.length < 3) throw new Error('El usuario debe tener al menos 3 caracteres');
  if (String(password || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
  const id = await userRowId(u);
  const existing = await getRemote(id);
  if (existing && existing.payload) {
    throw new Error('Ese usuario ya existe. Elige otro o inicia sesión.');
  }
  const verifier = await passwordVerifier(u, password);
  const payload = await encryptPayload(u, password, collectSnapshot());
  await upsertRemote(id, payload, verifier);
  saveSession(u, password);
  setMeta(undefined, snapshotByteSize());
  return { username: u };
}

/** Entrar: exige fila existente + contraseña que descifre. */
export async function login(username, password) {
  if (!configured()) throw new Error('Sincronización no configurada en el servidor');
  const u = normalizeUser(username);
  if (!u || !password) throw new Error('Usuario y contraseña obligatorios');
  const id = await userRowId(u);
  const row = await getRemote(id);
  if (!row || !row.payload) {
    throw new Error('Usuario no encontrado. Crea una cuenta primero.');
  }
  const snap = await decryptPayload(u, password, row.payload);
  writeKeyMap(mergeKeyMaps(collectSnapshot(), snap));
  saveSession(u, password);
  setMeta(row.updated_at, snapshotByteSize());
  // Tras login, subir estado fusionado (local + remoto) con verificador correcto
  try {
    const verifier = await passwordVerifier(u, password);
    const payload = await encryptPayload(u, password, collectSnapshot());
    await upsertRemote(id, payload, verifier);
    setMeta(undefined, snapshotByteSize());
  } catch (e) {
    console.warn('[sync] post-login push', e);
  }
  return { username: u, updatedAt: row.updated_at };
}

/**
 * Subir solo si la contraseña es la correcta.
 * 1) Si hay datos remotos, deben descifrarse con esta contraseña.
 * 2) El servidor exige el mismo verificador que al crear la cuenta.
 */
export async function push() {
  const u = localStorage.getItem(LS_USER);
  const p = localStorage.getItem(LS_PASS);
  if (!u || !p) return false;
  const id = await userRowId(u);
  const row = await getRemote(id);
  if (row?.payload) {
    // Prueba de contraseña + fusión: no sobrescribir progreso de otros equipos
    const remoteSnap = await decryptPayload(u, p, row.payload);
    writeKeyMap(mergeKeyMaps(collectSnapshot(), remoteSnap, { preferLocal: true }));
  }
  const verifier = await passwordVerifier(u, p);
  const payload = await encryptPayload(u, p, collectSnapshot());
  await upsertRemote(id, payload, verifier);
  setMeta(undefined, snapshotByteSize());
  return true;
}

export async function pull() {
  const u = localStorage.getItem(LS_USER);
  const p = localStorage.getItem(LS_PASS);
  if (!u || !p) return false;
  const id = await userRowId(u);
  const row = await getRemote(id);
  if (!row?.payload) return false;
  const remoteSnap = await decryptPayload(u, p, row.payload);
  const localSnap = collectSnapshot();
  const localKeys = localSnap?.keys && typeof localSnap.keys === 'object' ? localSnap.keys : {};
  const merged = mergeKeyMaps(localSnap, remoteSnap);
  const before = JSON.stringify(localKeys);
  writeKeyMap(merged);
  setMeta(row.updated_at, snapshotByteSize());
  if (JSON.stringify(collectSnapshot().keys) !== before) {
    try { window.dispatchEvent(new CustomEvent('tg-sync-pulled')); } catch (_) {}
  }
  return true;
}

let autoTimer = null;
let autoBusy = false;
/**
 * Sincronización casi inmediata: pull al volver a la pestaña/app y cada N segundos
 * mientras está visible. Emite 'tg-sync-pulled' solo si algo cambió.
 */
export function startAutoPull(intervalMs = 15000) {
  if (typeof window === 'undefined' || autoTimer) return;
  const tick = async () => {
    if (autoBusy || !isLoggedIn() || document.visibilityState !== 'visible') return;
    if (pushTimer) return; // hay cambios locales pendientes: primero subirlos
    autoBusy = true;
    try { await pull(); } catch (e) { console.warn('[sync] auto-pull', e); } finally { autoBusy = false; }
  };
  autoTimer = setInterval(tick, intervalMs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('focus', tick);
  window.addEventListener('online', tick);
}

let pushTimer = null;
let flushBound = false;

/** Debounce: sube tras cada cambio local (progreso, títulos, prefs…). */
export function schedulePush(ms = 800) {
  if (!isLoggedIn()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    push().catch((e) => console.warn('[sync] push', e));
  }, ms);
  ensureFlushHooks();
}

/** Empuja al instante (cerrar pestaña / cambiar app). */
export function flushPush() {
  if (!isLoggedIn()) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  push().catch((e) => console.warn('[sync] flush', e));
}

function ensureFlushHooks() {
  if (flushBound || typeof window === 'undefined') return;
  flushBound = true;
  const go = () => { try { flushPush(); } catch (_) {} };
  window.addEventListener('pagehide', go);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') go();
  });
}

function showBootOverlay(text) {
  let ov = document.getElementById('sync-boot');
  if (!ov) {
    ov = el('div', 'sync-boot');
    ov.id = 'sync-boot';
    const box = el('div', 'sync-boot-box');
    box.append(el('div', 'sync-boot-title', 'Sincronizando'));
    const bar = el('div', 'sync-boot-bar');
    bar.append(el('div', 'sync-boot-bar-fill'));
    box.append(bar);
    const msg = el('p', 'sync-boot-msg', text || 'Descargando datos…');
    msg.id = 'sync-boot-msg';
    box.append(msg);
    ov.append(box);
    document.body.append(ov);
  } else {
    const msg = document.getElementById('sync-boot-msg');
    if (msg) msg.textContent = text || 'Descargando datos…';
  }
  return ov;
}

function hideBootOverlay() {
  document.getElementById('sync-boot')?.remove();
}

/**
 * Arranque: pull con fusión (progreso = max, leídos = unión) y luego push del resultado.
 */
export async function syncOnStartup() {
  if (!configured() || !isLoggedIn()) return { synced: false };
  showBootOverlay('Descargando datos de la nube…');
  try {
    await pull();
    showBootOverlay('Guardando estado fusionado…');
    await push();
    showBootOverlay('Listo');
    return { synced: true };
  } catch (e) {
    console.warn('[sync] startup', e);
    showBootOverlay(e.message || 'Error de sincronización');
    // No bloquear la app eternamente
    await new Promise((r) => setTimeout(r, 1200));
    return { synced: false, error: e };
  } finally {
    hideBootOverlay();
  }
}

/** @deprecated usar syncOnStartup */
function startBackgroundSync() {
  /* no-op */
}

/**
 * UI: crear / entrar / estado.
 * @param {{ onAfterAuth?: () => void }} opts
 */
export function showSyncFrame(opts = {}) {
  document.querySelector('.info-frame.sync-frame')?.remove();
  const frame = el('div', 'info-frame sync-frame');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Sincronización'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');

  const status = el('p', 'sync-status', '');
  const setStatus = (t, isErr) => {
    status.textContent = t || '';
    status.classList.toggle('sync-err', !!isErr);
  };

  const renderLoggedIn = () => {
    body.replaceChildren();
    body.append(el('div', 'info-sec', 'Sesión activa'));
    const row = el('div', 'info-row');
    row.append(el('span', 'info-label', 'Usuario'), el('span', 'info-value', currentUsername()));
    body.append(row);
    let metaAt = '';
    let metaSize = 0;
    try {
      const meta = JSON.parse(localStorage.getItem(LS_META) || '{}') || {};
      metaAt = meta.updatedAt || '';
      metaSize = meta.sizeBytes || 0;
    } catch (_) {}
    // Tamaño actual del snapshot (más fiable que el guardado)
    const liveSize = snapshotByteSize() || metaSize;
    if (metaAt) {
      const r2 = el('div', 'info-row');
      r2.append(
        el('span', 'info-label', 'Última sync'),
        el('span', 'info-value', formatSyncDate(metaAt))
      );
      body.append(r2);
    }
    const r3 = el('div', 'info-row');
    r3.append(
      el('span', 'info-label', 'Datos sincronizados'),
      el('span', 'info-value', formatSyncBytes(liveSize))
    );
    body.append(r3);
    body.append(el('p', 'cover-pick-hint', 'Al abrir la app se bajan los datos; cada cambio local se sube solo. Aquí puedes forzar subida o bajada. El tamaño es el de preferencias, progreso y renombres (no incluye imágenes en caché).'));
    body.append(status);
    const actions = el('div', 'edit-actions sync-actions');
    const btnPull = el('button', 'btn', 'Bajar ahora');
    btnPull.onclick = async () => {
      setStatus('Bajando…');
      try {
        await pull();
        setStatus('Actualizado desde la nube');
        renderLoggedIn();
        opts.onAfterAuth?.();
      } catch (e) {
        setStatus(e.message || String(e), true);
      }
    };
    const btnPush = el('button', 'btn', 'Subir ahora');
    btnPush.onclick = async () => {
      setStatus('Subiendo…');
      try {
        await push();
        setStatus('Datos subidos');
        renderLoggedIn();
      } catch (e) {
        setStatus(e.message || String(e), true);
      }
    };
    const btnOut = el('button', 'btn', 'Cerrar sesión');
    btnOut.onclick = () => {
      logout();
      setStatus('');
      renderLoggedOut();
    };
    actions.append(btnPull, btnPush, btnOut);
    body.append(actions);
  };

  const formFields = (mode) => {
    body.replaceChildren();
    body.append(el('div', 'info-sec', mode === 'register' ? 'Crear cuenta' : 'Iniciar sesión'));
    if (!configured()) {
      body.append(el('p', 'sync-status sync-err', 'Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.'));
      return;
    }
    body.append(el('p', 'cover-pick-hint',
      mode === 'register'
        ? 'Usuario único. Si ya existe, no se podrá crear. La contraseña protege tus datos en la nube.'
        : 'Mismo usuario y contraseña en todos los dispositivos.'
    ));
    const inputU = el('input', 'edit-input');
    inputU.type = 'text';
    inputU.autocomplete = 'username';
    inputU.placeholder = 'Usuario (mín. 3)';
    const inputP = el('input', 'edit-input');
    inputP.type = 'password';
    inputP.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    inputP.placeholder = 'Contraseña (mín. 6)';
    body.append(el('label', 'sync-label', 'Usuario'), inputU);
    body.append(el('label', 'sync-label', 'Contraseña'), inputP);
    let inputP2 = null;
    if (mode === 'register') {
      inputP2 = el('input', 'edit-input');
      inputP2.type = 'password';
      inputP2.autocomplete = 'new-password';
      inputP2.placeholder = 'Repetir contraseña';
      body.append(el('label', 'sync-label', 'Repetir contraseña'), inputP2);
    }
    body.append(status);
    const actions = el('div', 'edit-actions sync-actions');
    const back = el('button', 'btn', 'Volver');
    back.onclick = () => renderLoggedOut();
    const go = el('button', 'btn edit-save', mode === 'register' ? 'Crear cuenta' : 'Entrar');
    go.onclick = async () => {
      setStatus(mode === 'register' ? 'Creando…' : 'Entrando…');
      try {
        if (mode === 'register') {
          if (inputP.value !== inputP2.value) throw new Error('Las contraseñas no coinciden');
          await register(inputU.value, inputP.value);
          setStatus('Cuenta creada');
        } else {
          await login(inputU.value, inputP.value);
          setStatus('Sesión iniciada');
        }
        opts.onAfterAuth?.();
        renderLoggedIn();
      } catch (e) {
        setStatus(e.message || String(e), true);
      }
    };
    actions.append(back, go);
    body.append(actions);
    setTimeout(() => inputU.focus(), 50);
  };

  const renderLoggedOut = () => {
    body.replaceChildren();
    body.append(el('div', 'info-sec', 'Cuenta de sincronización'));
    body.append(el('p', 'cover-pick-hint',
      'Al abrir la app se actualiza el progreso (p. ej. Seguir leyendo). Cada cambio se sube automáticamente. No se sube la sesión de Telegram.'
    ));
    if (!configured()) {
      body.append(el('p', 'sync-status sync-err', 'Supabase no configurado (variables VITE_ en Vercel).'));
    }
    body.append(status);
    const actions = el('div', 'edit-actions sync-actions');
    const btnLogin = el('button', 'btn edit-save', 'Iniciar sesión');
    btnLogin.onclick = () => formFields('login');
    const btnReg = el('button', 'btn', 'Crear usuario');
    btnReg.onclick = () => formFields('register');
    actions.append(btnLogin, btnReg);
    body.append(actions);
  };

  if (isLoggedIn()) renderLoggedIn();
  else renderLoggedOut();

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera
  document.body.append(frame);
}
