/**
 * Sincronización multi-dispositivo vía Supabase (opción A).
 * Usuario + contraseña → id = SHA-256(usuario), payload cifrado AES-GCM.
 * No incluye tg_session ni cachés de portadas.
 */

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const SCHEMA = 1;
const LS_USER = 'sync:username';
const LS_PASS = 'sync:password';
const LS_META = 'sync:meta'; // { updatedAt }

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

async function deriveKey(username, password) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  // Salt estable por usuario (no se guarda en servidor)
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
    throw new Error('Supabase ' + res.status + (t ? ': ' + t.slice(0, 120) : ''));
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

async function upsertRemote(id, payload) {
  await rpc('upsert_comic_sync', {
    p_id: id,
    p_payload: payload,
    p_schema_version: SCHEMA,
  });
}

/** Snapshot local (solo datos de usuario, sin Telegram ni portadas) */
export function collectSnapshot() {
  const data = {
    v: SCHEMA,
    prefs: {},
    kv: {},
    keys: {},
  };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k === 'tg_session' || k.startsWith('sync:')) continue;
      const syncKey = SYNC_KEYS.includes(k) || SYNC_PREFIXES.some((p) => k.startsWith(p));
      if (!syncKey) continue;
      // No subir progreso legado ambiguo si hay forma canal+msg; se suben todos page:/pages:
      data.keys[k] = localStorage.getItem(k);
    }
  } catch (_) {}
  return data;
}

/** Aplica snapshot remoto: fusiona (remoto gana en conflicto de clave) */
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

/**
 * Crear cuenta nueva. Falla si el usuario ya tiene fila en Supabase.
 */
export async function register(username, password) {
  if (!configured()) throw new Error('Sincronización no configurada en el servidor');
  const u = normalizeUser(username);
  if (u.length < 3) throw new Error('El usuario debe tener al menos 3 caracteres');
  if (String(password || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
  const id = await sha256Hex('tgcomic-user:' + u);
  const existing = await getRemote(id);
  if (existing && existing.payload) {
    throw new Error('Ese usuario ya existe. Elige otro o inicia sesión.');
  }
  const snap = collectSnapshot();
  const payload = await encryptPayload(u, password, snap);
  await upsertRemote(id, payload);
  saveSession(u, password);
  try {
    localStorage.setItem(LS_META, JSON.stringify({ updatedAt: new Date().toISOString() }));
  } catch (_) {}
  return { username: u };
}

/**
 * Iniciar sesión en cuenta existente y fusionar datos remotos.
 */
export async function login(username, password) {
  if (!configured()) throw new Error('Sincronización no configurada en el servidor');
  const u = normalizeUser(username);
  if (!u || !password) throw new Error('Usuario y contraseña obligatorios');
  const id = await sha256Hex('tgcomic-user:' + u);
  const row = await getRemote(id);
  if (!row || !row.payload) {
    throw new Error('Usuario no encontrado. Crea una cuenta primero.');
  }
  const snap = await decryptPayload(u, password, row.payload);
  applySnapshot(snap);
  saveSession(u, password);
  try {
    localStorage.setItem(LS_META, JSON.stringify({ updatedAt: row.updated_at || new Date().toISOString() }));
  } catch (_) {}
  return { username: u, updatedAt: row.updated_at };
}

/** Sube el estado local cifrado (requiere sesión). */
export async function push() {
  const u = localStorage.getItem(LS_USER);
  const p = localStorage.getItem(LS_PASS);
  if (!u || !p) return false;
  const id = await sha256Hex('tgcomic-user:' + u);
  const payload = await encryptPayload(u, p, collectSnapshot());
  await upsertRemote(id, payload);
  try {
    localStorage.setItem(LS_META, JSON.stringify({ updatedAt: new Date().toISOString() }));
  } catch (_) {}
  return true;
}

/** Baja y fusiona desde la nube. */
export async function pull() {
  const u = localStorage.getItem(LS_USER);
  const p = localStorage.getItem(LS_PASS);
  if (!u || !p) return false;
  const id = await sha256Hex('tgcomic-user:' + u);
  const row = await getRemote(id);
  if (!row?.payload) return false;
  const snap = await decryptPayload(u, p, row.payload);
  applySnapshot(snap);
  try {
    localStorage.setItem(LS_META, JSON.stringify({ updatedAt: row.updated_at || new Date().toISOString() }));
  } catch (_) {}
  return true;
}

let pushTimer = null;
/** Debounce tras cambios locales */
export function schedulePush(ms = 1500) {
  if (!isLoggedIn()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    push().catch((e) => console.warn('[sync] push', e));
  }, ms);
}

/** Arranque: si hay sesión, intentar pull en segundo plano */
export function startBackgroundSync() {
  if (!configured() || !isLoggedIn()) return;
  pull().catch((e) => console.warn('[sync] pull', e));
}

/**
 * UI: marco de sincronización (crear / entrar / estado).
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
    body.append(status);
    const actions = el('div', 'edit-actions sync-actions');
    const btnPull = el('button', 'btn', 'Bajar ahora');
    btnPull.onclick = async () => {
      setStatus('Bajando…');
      try {
        await pull();
        setStatus('Datos actualizados desde la nube');
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
    body.append(el('p', 'cover-pick-hint', 'Cerrar sesión solo afecta a este dispositivo. Tus datos en la nube se conservan.'));
  };

  const formFields = (mode) => {
    // mode: 'login' | 'register'
    body.replaceChildren();
    body.append(el('div', 'info-sec', mode === 'register' ? 'Crear cuenta' : 'Iniciar sesión'));
    if (!configured()) {
      body.append(el('p', 'sync-status sync-err', 'Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY en el servidor.'));
      return;
    }
    body.append(el('p', 'cover-pick-hint',
      mode === 'register'
        ? 'Elige un usuario único y una contraseña. Si el usuario ya existe, no se podrá crear.'
        : 'Usa el mismo usuario y contraseña en todos tus dispositivos.'
    ));

    const labU = el('label', 'sync-label', 'Usuario');
    const inputU = el('input', 'edit-input');
    inputU.type = 'text';
    inputU.autocomplete = 'username';
    inputU.placeholder = 'mín. 3 caracteres';
    const labP = el('label', 'sync-label', 'Contraseña');
    const inputP = el('input', 'edit-input');
    inputP.type = 'password';
    inputP.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    inputP.placeholder = 'mín. 6 caracteres';
    body.append(labU, inputU, labP, inputP);

    if (mode === 'register') {
      const labP2 = el('label', 'sync-label', 'Repetir contraseña');
      const inputP2 = el('input', 'edit-input');
      inputP2.type = 'password';
      inputP2.autocomplete = 'new-password';
      body.append(labP2, inputP2);
      body.append(status);
      const actions = el('div', 'edit-actions sync-actions');
      const back = el('button', 'btn', 'Volver');
      back.onclick = () => renderLoggedOut();
      const go = el('button', 'btn edit-save', 'Crear cuenta');
      go.onclick = async () => {
        setStatus('Creando…');
        if (inputP.value !== inputP2.value) {
          setStatus('Las contraseñas no coinciden', true);
          return;
        }
        try {
          await register(inputU.value, inputP.value);
          setStatus('Cuenta creada y sincronizada');
          opts.onAfterAuth?.();
          renderLoggedIn();
        } catch (e) {
          setStatus(e.message || String(e), true);
        }
      };
      actions.append(back, go);
      body.append(actions);
    } else {
      body.append(status);
      const actions = el('div', 'edit-actions sync-actions');
      const back = el('button', 'btn', 'Volver');
      back.onclick = () => renderLoggedOut();
      const go = el('button', 'btn edit-save', 'Entrar');
      go.onclick = async () => {
        setStatus('Entrando…');
        try {
          await login(inputU.value, inputP.value);
          setStatus('Sesión iniciada');
          opts.onAfterAuth?.();
          renderLoggedIn();
        } catch (e) {
          setStatus(e.message || String(e), true);
        }
      };
      actions.append(back, go);
      body.append(actions);
    }
    setTimeout(() => inputU.focus(), 50);
  };

  const renderLoggedOut = () => {
    body.replaceChildren();
    body.append(el('div', 'info-sec', 'Cuenta de sincronización'));
    body.append(el('p', 'cover-pick-hint',
      'Sincroniza progreso, títulos y nombres de serie entre dispositivos. No se sube la sesión de Telegram.'
    ));
    if (!configured()) {
      body.append(el('p', 'sync-status sync-err', 'Supabase no está configurado (variables VITE_ en Vercel).'));
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
