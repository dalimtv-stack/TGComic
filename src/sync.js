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

const SYNC_PREFIXES = [
  'pref:',
  'page:',
  'pages:',
  'pagefmt:',
  'seriesName:',
  'comicName:',
  'ungroup:',
];
const SYNC_KEYS = ['channelNames', 'groupNames', 'lastRead'];

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

async function deriveKey(username, password) {
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
  const data = { v: SCHEMA, keys: {} };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k === 'tg_session' || k.startsWith('sync:')) continue;
      const ok = SYNC_KEYS.includes(k) || SYNC_PREFIXES.some((p) => k.startsWith(p));
      if (!ok) continue;
      data.keys[k] = localStorage.getItem(k);
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
}

function setMeta(updatedAt) {
  try {
    localStorage.setItem(LS_META, JSON.stringify({ updatedAt: updatedAt || new Date().toISOString() }));
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
  setMeta();
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
  applySnapshot(snap);
  saveSession(u, password);
  setMeta(row.updated_at);
  // Tras login, subir estado fusionado (local + remoto) con verificador correcto
  try {
    const verifier = await passwordVerifier(u, password);
    const payload = await encryptPayload(u, password, collectSnapshot());
    await upsertRemote(id, payload, verifier);
    setMeta();
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
    // Prueba de contraseña en cliente antes de tocar el servidor
    await decryptPayload(u, p, row.payload);
  }
  const verifier = await passwordVerifier(u, p);
  const payload = await encryptPayload(u, p, collectSnapshot());
  await upsertRemote(id, payload, verifier);
  setMeta();
  return true;
}

export async function pull() {
  const u = localStorage.getItem(LS_USER);
  const p = localStorage.getItem(LS_PASS);
  if (!u || !p) return false;
  const id = await userRowId(u);
  const row = await getRemote(id);
  if (!row?.payload) return false;
  const snap = await decryptPayload(u, p, row.payload);
  applySnapshot(snap);
  setMeta(row.updated_at);
  return true;
}

let pushTimer = null;
/** Debounce: sube tras cada cambio local (progreso, títulos, prefs…). */
export function schedulePush(ms = 1500) {
  if (!isLoggedIn()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    push().catch((e) => console.warn('[sync] push', e));
  }, ms);
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
 * Llamar al arranque ANTES de mostrar la biblioteca / seguir leyendo.
 * Si hay sesión: pull (+ push del estado fusionado). Si no, no hace nada.
 */
export async function syncOnStartup() {
  if (!configured() || !isLoggedIn()) return { synced: false };
  showBootOverlay('Descargando datos de la nube…');
  try {
    await pull();
    showBootOverlay('Guardando estado…');
    // Sube el merge local+remoto solo con contraseña correcta
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
export function startBackgroundSync() {
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
    let meta = '';
    try {
      meta = JSON.parse(localStorage.getItem(LS_META) || '{}').updatedAt || '';
    } catch (_) {}
    if (meta) {
      const r2 = el('div', 'info-row');
      r2.append(el('span', 'info-label', 'Última sync'), el('span', 'info-value', String(meta)));
      body.append(r2);
    }
    body.append(el('p', 'cover-pick-hint', 'Al abrir la app se bajan los datos; cada cambio local se sube solo. Aquí puedes forzar subida o bajada.'));
    body.append(status);
    const actions = el('div', 'edit-actions sync-actions');
    const btnPull = el('button', 'btn', 'Bajar ahora');
    btnPull.onclick = async () => {
      setStatus('Bajando…');
      try {
        await pull();
        setStatus('Actualizado desde la nube');
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
  frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
  document.body.append(frame);
}
