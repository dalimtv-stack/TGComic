/**
 * Portadas de cómics: generación, optimización y nodos de UI.
 */
import { isComicRead as isComicReadImport, readProgress as readProgressImport } from './progress.js';
import { parseQuality, sourceNameOf, stripQualityTags, flattenVersions } from './quality.js';

export function createCovers(state, d) {
  const {
    el, kv, zip,
    TgReader, getMsg, pageBlob, sniff, pagesOf, openPages,
    readProgress: readProgressDep, isComicRead: isComicReadDep, stripExt,
    getCoverFit,
  } = d;
  const isComicRead = isComicReadDep || isComicReadImport;
  const readProgress = readProgressDep || readProgressImport;


  /** Primera página legible: ZIP (trozos) o openPages (PDF / RAR completo). */
  async function firstPageBlobFromMsg(ch, f, msg, size, status) {
    const st = typeof status === 'function' ? status : () => {};
    const r = new TgReader(msg, size);
    const kind = await sniff(r);
    if (kind === 'zip') {
      st('Leyendo CBZ…');
      const zr = new zip.ZipReader(r);
      try {
        const first = pagesOf(await zr.getEntries())[0];
        if (!first) return null;
        st('Miniatura…');
        return await pageBlob(first);
      } finally {
        try { await zr.close(); } catch (_) {}
      }
    }
    if (typeof openPages === 'function') {
      // CBR/PDF: openPages descarga el archivo entero (inevitable con RAR)
      const ac = { cancelled: false };
      const arc = await openPages(msg, size, st, ac);
      try {
        const pages = arc?.pages || [];
        if (!pages.length) return null;
        st('Miniatura…');
        return await pageBlob(pages[0]);
      } finally {
        try { arc?.close?.(); } catch (_) {}
      }
    }
    return null;
  }

  const cq = [];
  let crun = 0;
  // Paralelismo alto otra vez: el fallo de «solo la 1ª» se arregla con reintentos + unobserve solo si OK,
  // no limitando a 1 (eso hacía la rejilla muy lenta en iPhone).
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const isMobile = isIOS || /Android/i.test(navigator.userAgent || '');
  const QUEUE_N = isIOS ? 9 : (isMobile ? 3 : 4);
  const COVER_TIMEOUT_MS = isIOS ? 100000 : 180000;

  function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(label || 'cover timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => { try { clearTimeout(t); } catch (_) {} });
  }

  const enqueue = (fn) => new Promise((res) => {
    cq.push(() => withTimeout(
      Promise.resolve().then(fn),
      COVER_TIMEOUT_MS,
      'cover timeout'
    ).then(res, (e) => { console.warn('[cover]', e); res(null); }));
    pump();
  });
  /** @param {{ force?: boolean }} [opts] force=true: procesa aunque state.reading (batch de portadas) */
  function pump(opts) {
    if (state.reading && !opts?.force) return;
    while (crun < QUEUE_N && cq.length) {
      crun++;
      const run = cq.shift();
      Promise.resolve()
        .then(() => run())
        .finally(() => {
          crun--;
          // Pequeña pausa en iOS entre portadas para no saturar getMessages / DC
          const gap = isIOS ? 60 : 0;
          if (gap) setTimeout(() => pump(opts), gap);
          else pump(opts);
        });
    }
  }

  async function getCover(ch, f, opts = {}) {
    // WebP / 2400 / IA: si hay original, usar la portada del original (no generar ni cachear otra)
    if (!opts.force && !opts._noRedirect) {
      try {
        const pq = parseQuality(sourceNameOf(f) || f?.name || '');
        if (pq.ai || pq.q === 'mid' || pq.q === 'low') {
          let all = [];
          try { all = (await kv.get('f:' + ch.id)) || []; } catch (_) {}
          const base = stripQualityTags(sourceNameOf(f) || f?.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
          let high = null;
          for (const x of flattenVersions(all)) {
            if (String(x.id) === String(f.id)) continue;
            const pq2 = parseQuality(sourceNameOf(x) || x?.name || '');
            const b2 = stripQualityTags(sourceNameOf(x) || x?.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (b2 === base && !pq2.ai && pq2.q === 'high') { high = x; break; }
          }
          // variants embebidas
          if (!high && f?.variants?.high) high = f.variants.high;
          if (high && String(high.id) !== String(f.id)) {
            return getCover(ch, high, { ...opts, _noRedirect: true });
          }
        }
      } catch (_) {}
    }
    const key = `c:${ch.id}:${f.id}`;
    if (opts.force) {
      try { await kv.del(key); } catch (_) {}
    }
    let b = opts.force ? null : await kv.get(key);
    if (b === 'none') b = undefined;

    // Portada personalizada sincronizada entre dispositivos (solo página + modo; la imagen se lee del cómic)
    try {
      const cfg = readCoverAdapt(ch, f);
      const ckey = coverCustomKey(ch, f);
      if (cfg === 'reset') {
        // Otro dispositivo (o Recargar portadas) restableció la portada: volver a la de por defecto
        if (await kv.get(ckey)) {
          try { await kv.del(key); } catch (_) {}
          try { await kv.del(ckey); } catch (_) {}
          b = undefined;
        }
      } else if (cfg) {
        const sig = adaptSig(cfg);
        const applied = await kv.get(ckey);
        if ((applied !== sig || !b) && !customFailed.has(ch.id + ':' + f.id + ':' + sig)) {
          const nb = await enqueue(() => makeCustomCover(ch, f, key, cfg));
          if (nb) {
            try { await kv.set(ckey, sig); } catch (_) {}
            return nb;
          }
          // Sin red / CBR / error: no reintentar en bucle durante esta sesión
          customFailed.add(ch.id + ':' + f.id + ':' + sig);
        }
      }
    } catch (_) {}

    if (!b) b = await enqueue(() => makeCover(ch, f, key));
    return b && b !== 'none' ? b : null;
  }

  // ----- Portada personalizada: configuración sincronizada (localStorage coverAdapt:ch:f) -----
  const customFailed = new Set();
  const adaptKey = (ch, f) => `coverAdapt:${ch.id}:${f.id}`;
  /** { page, mode, half } | 'reset' (marca de borrado sincronizada) | null (sin configuración) */
  function readCoverAdapt(ch, f) {
    try {
      const raw = localStorage.getItem(adaptKey(ch, f));
      if (raw == null) return null;
      if (raw === '0') return 'reset';
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return 'reset';
      return {
        page: Math.max(0, Math.floor(Number(v.page) || 0)),
        mode: ['left', 'center', 'right', 'full'].includes(v.mode) ? v.mode : 'full',
        half: v.half !== false,
      };
    } catch (_) { return null; }
  }
  const adaptSig = (c) => `${c.page}|${c.mode}|${c.half ? 1 : 0}`;
  function currentSig(ch, f) {
    const c = readCoverAdapt(ch, f);
    return c && c !== 'reset' ? adaptSig(c) : null;
  }

  /** Recorta una página apaisada según modo (mismo criterio que «Adaptar portada»). */
  async function cropForCover(blob, mode, exactHalf) {
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { return null; }
    const sw = bmp.width, sh = bmp.height;
    let sx = 0, sy = 0, cw = sw, chh = sh;
    if (sw > sh && (mode === 'left' || mode === 'center' || mode === 'right')) {
      if (exactHalf && (mode === 'left' || mode === 'right')) {
        cw = Math.max(1, Math.floor(sw / 2));
        sx = mode === 'right' ? sw - cw : 0;
      } else {
        chh = sh;
        cw = Math.round(chh * (2 / 3));
        if (cw > sw) { cw = sw; chh = Math.round(cw / (2 / 3)); sy = Math.round((sh - chh) / 2); }
        if (mode === 'center') sx = Math.round((sw - cw) / 2);
        else if (mode === 'right') sx = Math.max(0, sw - cw);
      }
    }
    const scale = Math.min(1, coverGenMaxEdge('comic', 560) / Math.max(cw, chh));
    const cv = el('canvas');
    cv.width = Math.max(1, Math.round(cw * scale));
    cv.height = Math.max(1, Math.round(chh * scale));
    cv.getContext('2d').drawImage(bmp, sx, sy, cw, chh, 0, 0, cv.width, cv.height);
    try { bmp.close?.(); } catch (_) {}
    let out = await canvasToBlob(cv, 'image/webp', 0.78);
    if (!(out && out.size && (out.type || '').includes('webp'))) out = await canvasToBlob(cv, 'image/jpeg', 0.72);
    cv.width = 0; cv.height = 0;
    return out && out.size ? out : null;
  }

  /** Genera la portada personalizada leyendo la página elegida del cómic (no se guarda la imagen de origen). */
  async function makeCustomCover(ch, f, key, cfg) {
    const msg = await getMsg(ch, f, { force: true });
    let size = Number(f?.size) || 0;
    try {
      if (msg?.document?.size != null) size = Number(msg.document.size.toString()) || size;
    } catch (_) {}
    if (!size) return null;
    try {
      const r = new TgReader(msg, size);
      const kind = await sniff(r);
      let src = null;
      if (kind === 'zip') {
        const zr = new zip.ZipReader(r);
        try {
          const pgs = pagesOf(await zr.getEntries());
          if (!pgs.length) return null;
          src = await pageBlob(pgs[Math.min(cfg.page, pgs.length - 1)]);
        } finally { zr.close().catch(() => {}); }
      } else if (typeof openPages === 'function') {
        const ac = { cancelled: false };
        const arc = await openPages(msg, size, () => {}, ac);
        try {
          const pgs = arc?.pages || [];
          if (!pgs.length) return null;
          src = await pageBlob(pgs[Math.min(cfg.page, pgs.length - 1)]);
        } finally { try { arc?.close?.(); } catch (_) {} }
      } else return null;
      if (!src) return null;
      const cropped = await cropForCover(src, cfg.mode, cfg.half);
      const out = await thumbFromBlob(cropped || src);
      if (out) await kv.set(key, out);
      return out;
    } catch (e) {
      console.warn('portada personalizada', e);
      return null;
    }
  }

  let _webpOk = null;
  /** true solo si toBlob('image/webp') devuelve type real image/webp (Safari a menudo miente). */
  async function supportsWebP() {
    if (_webpOk != null) return _webpOk;
    _webpOk = await new Promise((res) => {
      try {
        const c = document.createElement('canvas');
        c.width = 2; c.height = 2;
        c.getContext('2d').fillRect(0, 0, 2, 2);
        c.toBlob((b) => res(!!(b && b.size && (b.type || '').includes('webp'))), 'image/webp', 0.8);
      } catch { res(false); }
    });
    return _webpOk;
  }

  function canvasToBlob(cv, type, quality) {
    return new Promise((res) => {
      try { cv.toBlob((b) => res(b || null), type, quality); }
      catch { res(null); }
    });
  }

  /**
   * Miniatura de portada: siempre reescala; nunca guarda la página completa.
   * PC → WebP ~16 KB; iPhone sin encoder WebP → JPEG más agresivo (antes devolvía
   * el blob original o un JPEG grande → más peso y peor aspecto).
   */
  async function optimizeImageBlob(blob, maxEdge = 280, quality = 0.72, opts = {}) {
    if (!blob || !blob.size) return null;
    const srcType = String(blob.type || '').toLowerCase();
    // Editoriales / logos: preservar transparencia (PNG/GIF/WebP con alpha)
    const keepAlpha = !!(opts && opts.keepAlpha) || srcType.includes('png') || srcType.includes('gif');
    // No re-encode logos pequeños: el canvas en Safari/iPhone a veces genera negro
    if (keepAlpha && blob.size > 0 && blob.size < 400 * 1024) {
      return blob;
    }

    // Miniatura ya OK (sin alpha forzada a comic covers)
    if (!keepAlpha && srcType.includes('webp') && blob.size < 48 * 1024) {
      try {
        const bmp0 = await createImageBitmap(blob);
        const ok = Math.max(bmp0.width, bmp0.height) <= maxEdge + 16;
        bmp0.close?.();
        if (ok) return blob;
      } catch (_) {}
    }
    // PNG/GIF pequeño ya reescalado: reutilizar
    if (keepAlpha && (srcType.includes('png') || srcType.includes('gif')) && blob.size < 120 * 1024) {
      try {
        const bmp0 = await createImageBitmap(blob);
        const ok = Math.max(bmp0.width, bmp0.height) <= maxEdge + 16;
        bmp0.close?.();
        if (ok) return blob;
      } catch (_) {}
    }

    let bmp = null;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      try {
        const url = URL.createObjectURL(blob);
        bmp = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = url;
        });
        try { URL.revokeObjectURL(url); } catch (_) {}
      } catch {
        return null;
      }
    }

    const srcW = bmp.width || bmp.naturalWidth || 0;
    const srcH = bmp.height || bmp.naturalHeight || 0;
    if (!srcW || !srcH) {
      try { bmp.close?.(); } catch (_) {}
      return null;
    }

    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const cv = el('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { alpha: keepAlpha });
    if (keepAlpha) {
      ctx.clearRect(0, 0, w, h);
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    try { bmp.close?.(); } catch (_) {}

    let out = null;
    if (keepAlpha) {
      // PNG mantiene transparencia; WebP con alpha si el navegador lo soporta bien
      out = await canvasToBlob(cv, 'image/png');
      if (!(out && out.size)) {
        if (await supportsWebP()) {
          const wout = await canvasToBlob(cv, 'image/webp', quality);
          if (wout && wout.size && (wout.type || '').includes('webp')) out = wout;
        }
      }
    } else {
      if (await supportsWebP()) {
        out = await canvasToBlob(cv, 'image/webp', quality);
        if (!(out && out.size && (out.type || '').includes('webp'))) out = null;
      }
      if (!out) {
        const jq = Math.min(0.62, quality);
        out = await canvasToBlob(cv, 'image/jpeg', jq);
      }
      if (!out || !out.size) {
        out = await canvasToBlob(cv, 'image/jpeg', 0.5);
      }
    }

    cv.width = 0;
    cv.height = 0;
    // NUNCA devolver el original (página completa de varios MB) salvo arte con alpha que no se pudo reescalar
    return out && out.size ? out : null;
  }

  /**
   * Si «Generar portadas con esta resolución» está activo (device:coverGenAtRes*),
   * el lado mayor de la miniatura = altura configurada (coverH*). Si no, fallback.
   */
  function coverGenMaxEdge(kind, fallback) {
    try {
      const flag = kind === 'series' ? 'coverGenAtResSeries'
        : kind === 'channel' ? 'coverGenAtResChannel'
        : 'coverGenAtResComic';
      if (localStorage.getItem('device:' + flag) !== '1') return fallback;
      const hKey = kind === 'series' ? 'coverHSeries'
        : kind === 'channel' ? 'coverHChannel'
        : 'coverHComic';
      const h = Math.max(100, Math.min(400, Number(localStorage.getItem('device:' + hKey) || 225) || 225));
      return h;
    } catch (_) {
      return fallback;
    }
  }

  // Lado mayor por defecto 280 px; si el check de resolución está on, usa coverH*
  const thumbFromBlob = (blob, kind = 'comic') =>
    optimizeImageBlob(blob, coverGenMaxEdge(kind, 280), 0.72);

  /** Marca de portada elegida/adaptada por el usuario (no la pisa el lector). */
  const coverCustomKey = (ch, f) => `ccustom:${ch.id}:${f.id}`;
  async function isCustomCover(ch, f) {
    if (!ch?.id || f?.id == null) return false;
    // También cuenta si otro dispositivo ya definió una portada personalizada (aún sin aplicar aquí)
    if (currentSig(ch, f)) return true;
    try { return !!(await kv.get(coverCustomKey(ch, f))); } catch { return false; }
  }
  async function markCustomCover(ch, f, on = true) {
    if (!ch?.id || f?.id == null) return;
    try {
      // Se guarda la firma de la configuración aplicada; si cambia (otro dispositivo), se regenera
      if (on) await kv.set(coverCustomKey(ch, f), currentSig(ch, f) || 1);
      else await kv.del(coverCustomKey(ch, f));
    } catch (_) {}
  }

  /**
   * Guarda miniatura de portada.
   * opts.custom = true → portada personalizada (Adaptar / Elegir página).
   * opts.auto = true → generada al abrir el cómic; no sobrescribe si hay custom.
   */
  async function saveCoverBlob(ch, f, blob, opts = {}) {
    if (!blob) return;
    const key = `c:${ch.id}:${f.id}`;
    try {
      if (opts.auto && (await isCustomCover(ch, f))) return;
      const out = await thumbFromBlob(blob);
      if (out) await kv.set(key, out);
      if (opts.custom) await markCustomCover(ch, f, true);
    } catch (e) { console.warn('portada', e); }
  }

  /**
   * Genera portada por defecto (1ª página).
   * opts.forceMsg = true → re-fetch mensaje Telegram.
   * opts.status(text) → progreso (CBR descarga completa).
   */

  /** No cachear portadas de WebP/2400/IA si existe la versión original (alta). */
  async function shouldSkipCoverCache(ch, f) {
    try {
      const pq = parseQuality(sourceNameOf(f) || f?.name || '');
      if (!pq.ai && pq.q === 'high') return false;
      let all = [];
      try { all = (await kv.get('f:' + ch.id)) || []; } catch (_) { return true; }
      const base = stripQualityTags(sourceNameOf(f) || f?.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!base) return true;
      for (const x of flattenVersions(all)) {
        if (String(x.id) === String(f.id)) continue;
        const pq2 = parseQuality(sourceNameOf(x) || x?.name || '');
        const b2 = stripQualityTags(sourceNameOf(x) || x?.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (b2 === base && !pq2.ai && pq2.q === 'high') return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async function makeCover(ch, f, key, opts = {}) {
    const st = typeof opts.status === 'function' ? opts.status : () => {};
    st('Mensaje…');
    let msg = await getMsg(ch, f, opts.forceMsg ? { force: true } : {});
    // Cómic recién subido: a veces el 1er getMessages llega sin document → un force arregla
    if (!msg?.document) {
      try { msg = await getMsg(ch, f, { force: true }); } catch (_) {}
    }
    if (!msg?.document) {
      console.warn('portada: sin document', ch?.id, f?.id);
      return null;
    }
    let size = Number(f?.size) || 0;
    try {
      if (msg.document.size != null) size = Number(msg.document.size.toString()) || size;
    } catch (_) {}
    if (!size) return null;
    try {
      const src = await firstPageBlobFromMsg(ch, f, msg, size, st);
      if (!src) return null;
      st('Comprimiendo…');
      const out = await thumbFromBlob(src);
      if (out && !(await shouldSkipCoverCache(ch, f))) await kv.set(key, out);
      return out;
    } catch (e) {
      const em = String(e?.message || e || '');
      if (!opts._retried) {
        try {
          st('Reintento…');
          const msg2 = await getMsg(ch, f, { force: true });
          if (!msg2?.document) return null;
          let size2 = size;
          try {
            if (msg2.document.size != null) size2 = Number(msg2.document.size.toString()) || size2;
          } catch (_) {}
          const src2 = await firstPageBlobFromMsg(ch, f, msg2, size2, st);
          if (!src2) return null;
          const out2 = await thumbFromBlob(src2);
          if (out2 && !(await shouldSkipCoverCache(ch, f))) await kv.set(key, out2);
          return out2;
        } catch (e2) {
          console.warn('portada auto retry', e2);
          return null;
        }
      }
      console.warn('portada auto', e);
      return null;
    }
  }

  /**
   * Genera portada sin la cola de UI (para «Cargar portadas faltantes»).
   * Evita quedarse bloqueado detrás de IntersectionObserver / state.reading.
   * opts.status(text) para mostrar progreso de descarga CBR.
   */
  async function generateCover(ch, f, opts = {}) {
    const key = `c:${ch.id}:${f.id}`;
    try {
      // No pisar portada personalizada
      if (await isCustomCover(ch, f)) {
        const existing = await kv.get(key);
        if (existing && existing !== 'none') return existing;
      }
      const b = await makeCover(ch, f, key, { status: opts.status });
      return b && b !== 'none' ? b : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Solo dejamos de observar cuando la portada cargó bien.
   * Antes: unobserve al primer intersect → si fallaba (flood/timeout en iPhone)
   * nunca se reintentaba y solo se veía la 1ª portada.
   */
  const io = new IntersectionObserver((es) => es.forEach((x) => {
    if (!x.isIntersecting) return;
    const el = x.target;
    if (!el || el._coverOk || el._coverLoading) return;
    el._coverLoading = true;
    Promise.resolve()
      .then(() => el._load?.())
      .catch((e) => console.warn('cover io', e))
      .finally(() => {
        el._coverLoading = false;
        if (el._coverOk) {
          try { io.unobserve(el); } catch (_) {}
        }
        // Si falló y sigue visible, reintentar tras una pausa
        else if (el.isConnected) {
          const n = (el._coverFails | 0) + 1;
          el._coverFails = n;
          const wait = Math.min(12000, 900 * n);
          setTimeout(() => {
            if (!el.isConnected || el._coverOk || el._coverLoading) return;
            // Volver a encolar si sigue en viewport (isIntersecting no se re-dispara solo)
            el._coverLoading = true;
            Promise.resolve()
              .then(() => el._load?.())
              .catch(() => {})
              .finally(() => {
                el._coverLoading = false;
                if (el._coverOk) {
                  try { io.unobserve(el); } catch (_) {}
                }
              });
          }, wait);
        }
      });
  }), { rootMargin: '500px 0px', threshold: 0.01 });

  function comicCover(ch, f, badge, series) {
    const d = el('div', 'cover cover-comic');
    const ltr = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
    d.append(ltr);
    if (badge != null && badge !== '') {
      d.append(el('span', series ? 'badge series' : 'badge', String(badge)));
    }
    const prog = series ? null : readProgress(ch.id, f.id);
    if (prog) {
      const bar = el('div', 'prog');
      const fill = el('div', 'prog-fill');
      fill.style.width = prog.pct + '%';
      bar.append(fill);
      d.append(bar);
      d.append(el('span', 'prog-badge', prog.pct >= 95 ? '✓' : prog.pct + '%'));
    } else if (!series && isComicRead(ch.id, f.id)) {
      const bar = el('div', 'prog');
      const fill = el('div', 'prog-fill');
      fill.style.width = '100%';
      bar.append(fill);
      d.append(bar);
      d.append(el('span', 'prog-badge', '✓'));
    }
    const paintBlob = (b) => {
      if (!b || !d.isConnected) return false;
      d._coverOk = true;
      const img = new Image();
      if (d._objUrl) { try { URL.revokeObjectURL(d._objUrl); } catch (_) {} }
      let url;
      try { url = URL.createObjectURL(b); } catch (_) { return false; }
      d._objUrl = url;
      img.onload = () => {
        if (!d.isConnected) return;
        try { ltr.remove(); } catch (_) {}
        if (d.querySelector('img')) d.querySelector('img').remove();
        try {
          if (img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalWidth > img.naturalHeight) {
            d.classList.add('landscape');
            try {
              const fit = (typeof getCoverFit === 'function' ? getCoverFit(ch, f) : 'full') || 'full';
              d.dataset.coverFit = fit;
            } catch (_) { d.dataset.coverFit = 'full'; }
          } else {
            d.classList.remove('landscape');
            try { delete d.dataset.coverFit; } catch (_) {}
          }
        } catch (_) {}
        d.prepend(img);
      };
      img.onerror = () => {
        try { URL.revokeObjectURL(url); } catch (_) {}
        if (d._objUrl === url) d._objUrl = null;
      };
      img.src = url;
      return true;
    };
    d._load = async () => {
      try {
        let b = await getCover(ch, f);
        if (paintBlob(b)) return;
        // Reintentos: cómics nuevos / iPhone (flood o timeout del 1er lote)
        for (let attempt = 0; attempt < 3 && d.isConnected && !d._coverOk; attempt++) {
          await new Promise((r) => setTimeout(r, 500 + attempt * 700));
          if (!d.isConnected) return;
          if (attempt >= 1) {
            try { await kv.del(`c:${ch.id}:${f.id}`); } catch (_) {}
            b = await enqueue(() => makeCover(ch, f, `c:${ch.id}:${f.id}`, { forceMsg: true, _retried: attempt > 1 }));
          } else {
            b = await getCover(ch, f, { force: false });
          }
          if (paintBlob(b)) return;
        }
      } catch (e) {
        console.warn('cover load', e);
      }
    };
    io.observe(d);
    return d;
  }

  return {
    getCover,
    generateCover,
    saveCoverBlob,
    isCustomCover,
    markCustomCover,
    optimizeImageBlob,
    coverGenMaxEdge,
    comicCover,
    pump,
    io,
    thumbFromBlob,
  };
}
