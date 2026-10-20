/**
 * UI compartida: diálogos, scroll lock, long-press, sheet, grid, helpers.
 */
export function createUi({ el, sync }) {
  const $ = (s) => document.querySelector(s);

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

/** Asigna blob a img con Object URL y revoca el anterior del owner. */
function setBlobImg(img, blob, owner) {
  if (!img || !blob) return null;
  try {
    if (owner && owner._objUrl) URL.revokeObjectURL(owner._objUrl);
  } catch (_) {}
  let url;
  try { url = URL.createObjectURL(blob); } catch (_) { return null; }
  if (owner) owner._objUrl = url;
  const prevErr = img.onerror;
  img.onerror = (ev) => {
    try { URL.revokeObjectURL(url); } catch (_) {}
    if (owner && owner._objUrl === url) owner._objUrl = null;
    if (typeof prevErr === 'function') prevErr.call(img, ev);
  };
  img.src = url;
  return url;
}


/** Diálogos centrados estilo TGComics (sustituyen alert/confirm/prompt del navegador). */
function appDialog({ title = '', message = '', confirmText = 'Aceptar', cancelText = null, input = null } = {}) {
  return new Promise((resolve) => {
    document.querySelectorAll('.app-dialog').forEach((n) => n.remove());
    const bg = el('div', 'app-dialog');
    const box = el('div', 'app-dialog-box');
    if (title) box.append(el('div', 'app-dialog-title', title));
    if (message) {
      const msg = el('div', 'app-dialog-msg');
      msg.textContent = message;
      box.append(msg);
    }
    let inp = null;
    if (input) {
      inp = el('input', 'edit-input app-dialog-input');
      inp.type = input.type || 'text';
      inp.value = input.value != null ? String(input.value) : '';
      inp.placeholder = input.placeholder || '';
      inp.autocomplete = input.type === 'password' ? 'current-password' : 'off';
      box.append(inp);
    }
    const actions = el('div', 'app-dialog-actions');
    const finish = (val) => { try { bg.remove(); } catch (_) {} resolve(val); };
    if (cancelText != null) {
      const c = el('button', 'btn', cancelText);
      c.onclick = () => finish(input ? null : false);
      actions.append(c);
    }
    const ok = el('button', 'btn edit-save', confirmText);
    ok.onclick = () => finish(input ? (inp ? inp.value : '') : true);
    actions.append(ok);
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(inp.value); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      });
    }
    box.append(actions);
    bg.append(box);
    bg.addEventListener('click', (ev) => {
      if (ev.target === bg && cancelText != null) finish(input ? null : false);
    });
    document.body.append(bg);
    try { (inp || ok).focus(); } catch (_) {}
  });
}
function appAlert(message, title = '') {
  return appDialog({ title, message, confirmText: 'Aceptar', cancelText: null });
}
function appConfirm(message, title = '') {
  return appDialog({ title, message, confirmText: 'Sí', cancelText: 'No' });
}
/** @returns {Promise<string|null>} null = cancelar */
function appPrompt(message, title = '', defaultValue = '', inputType = 'text') {
  return appDialog({
    title: title || '',
    message,
    confirmText: 'Aceptar',
    cancelText: 'Cancelar',
    input: { type: inputType || 'text', value: defaultValue || '', placeholder: '' },
  });
}
// Exponer para upload/repack/lock
try {
  window.appAlert = appAlert;
  window.appConfirm = appConfirm;
  window.appPrompt = appPrompt;
} catch (_) {}

/** Android: pantalla completa de toda la app (reintenta hasta lograrlo; un solo aviso al éxito). */
(() => {
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  if (!isAndroid) return;
  let done = false;
  let pending = false;
  const request = () => {
    if (done || pending) return;
    const root = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      done = true;
      return;
    }
    const req = root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen;
    if (typeof req !== 'function') return;
    pending = true;
    try {
      const p = req.call(root, { navigationUI: 'hide' });
      if (p && typeof p.then === 'function') {
        p.then(() => { done = true; pending = false; })
          .catch(() => { pending = false; });
      } else {
        // Safari viejo: esperamos fullscreenchange
        pending = false;
      }
    } catch (_) {
      pending = false;
    }
  };
  const onGesture = () => { if (!done) request(); };
  ['pointerdown', 'touchstart', 'click'].forEach((ev) => {
    document.addEventListener(ev, onGesture, { passive: true, capture: true });
  });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      done = true;
      pending = false;
    } else {
      // Si el usuario sale de FS, no forzar de nuevo automáticamente
      done = true;
    }
  });
})();

/** Bloquea el scroll de fondo detrás de Información / formularios.
 *  No usar position:fixed en body: en listados largos provoca franja negra / overlay a medias. */
function lockAppScroll() {
  if (document.body.classList.contains('body-scroll-lock')) return;
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.dataset.lockY = String(y);
  document.body.classList.add('body-scroll-lock');
  document.documentElement.classList.add('body-scroll-lock');
  // Solo overflow: el overlay .info-frame cubre el viewport con position:fixed
}
function unlockAppScroll() {
  if (document.querySelector('.info-frame, .sheet')) return;
  if (!document.body.classList.contains('body-scroll-lock')) return;
  const y = Math.max(0, +(document.body.dataset.lockY || 0) || 0);
  document.body.classList.remove('body-scroll-lock');
  document.documentElement.classList.remove('body-scroll-lock');
  // Por si quedó residual de versiones anteriores
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
  // Escritorio: clic derecho → menú (sin dejar opened=true, si no el 1.er click izquierdo se come)
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    opened = false;
    armed = false;
    clear();
    try { fn(e); } catch (_) {}
  }, true);
  // Tras long-press táctil, el click sintético no debe abrir el cómic
  node.addEventListener('click', (e) => {
    if (armed || opened) {
      e.preventDefault();
      e.stopPropagation();
      armed = false;
      opened = false;
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
      appPrompt(text, 'Copiar', text, 'text');
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

  return {
    $,
    resetMobileViewport,
    setBlobImg,
    appDialog,
    appAlert,
    appConfirm,
    appPrompt,
    lockAppScroll,
    unlockAppScroll,
    bindLongPress,
    formatPeople,
    copyInfoFrameText,
    showDescriptionPanel,
    grid,
    sheet,
  };
}
