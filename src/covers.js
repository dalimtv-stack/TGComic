/**
 * Portadas de cómics: generación, optimización y nodos de UI.
 */
import { isComicRead as isComicReadImport, readProgress as readProgressImport } from './progress.js';

export function createCovers(state, d) {
  const {
    el, kv, zip,
    TgReader, getMsg, pageBlob, sniff, pagesOf,
    readProgress: readProgressDep, isComicRead: isComicReadDep, stripExt,
  } = d;
  const isComicRead = isComicReadDep || isComicReadImport;
  const readProgress = readProgressDep || readProgressImport;

  const cq = [];
  let crun = 0;
  const enqueue = (fn) => new Promise((res) => {
    cq.push(() => fn().then(res, () => res(null)));
    pump();
  });
  function pump() {
    if (state.reading) return;
    while (crun < 2 && cq.length) {
      crun++;
      cq.shift()().finally(() => { crun--; pump(); });
    }
  }

  async function getCover(ch, f, opts = {}) {
    const key = `c:${ch.id}:${f.id}`;
    if (opts.force) {
      try { await kv.del(key); } catch (_) {}
    }
    let b = opts.force ? null : await kv.get(key);
    if (b === 'none') b = undefined;
    if (!b) b = await enqueue(() => makeCover(ch, f, key));
    return b && b !== 'none' ? b : null;
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

  // Lado mayor 280 px; en rejilla se ve bien y limita peso en iPhone (JPEG)
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
    // Siempre mensaje fresco: si se resubió el archivo en Telegram, el media cambia
    const msg = await getMsg(ch, f, { force: true });
    let size = Number(f?.size) || 0;
    try {
      if (msg?.document?.size != null) size = Number(msg.document.size.toString()) || size;
    } catch (_) {}
    if (!size) return null;
    const r = new TgReader(msg, size);
    if ((await sniff(r)) !== 'zip') return null;
    const zr = new zip.ZipReader(r);
    try {
      const first = pagesOf(await zr.getEntries())[0];
      if (!first) return null;
      const out = await thumbFromBlob(await pageBlob(first));
      if (out) await kv.set(key, out);
      return out;
    } catch (e) {
      const em = String(e?.message || e || '');
      if (/central directory|end of central|invalid zip|corrupt/i.test(em)) {
        // Reintento con otro getMsg por si quedó un mensaje a medias
        try {
          const msg2 = await getMsg(ch, f, { force: true });
          let size2 = size;
          try {
            if (msg2?.document?.size != null) size2 = Number(msg2.document.size.toString()) || size2;
          } catch (_) {}
          const r2 = new TgReader(msg2, size2);
          if ((await sniff(r2)) !== 'zip') return null;
          const zr2 = new zip.ZipReader(r2);
          try {
            const first2 = pagesOf(await zr2.getEntries())[0];
            if (!first2) return null;
            const out2 = await thumbFromBlob(await pageBlob(first2));
            if (out2) await kv.set(key, out2);
            return out2;
          } finally { zr2.close().catch(() => {}); }
        } catch (_) { return null; }
      }
      throw e;
    } finally { zr.close().catch(() => {}); }
  }

  const io = new IntersectionObserver((es) => es.forEach((x) => {
    if (x.isIntersecting) { io.unobserve(x.target); x.target._load?.(); }
  }), { rootMargin: '400px' });

  function comicCover(ch, f, badge, series) {
    const d = el('div', 'cover');
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
    d._load = async () => {
      const b = await getCover(ch, f);
      if (!b) return;
      const img = new Image();
      // Revocar solo al sustituir (no MutationObserver: en iPhone provocaba parpadeo y retrasos)
      if (d._objUrl) { try { URL.revokeObjectURL(d._objUrl); } catch (_) {} }
      let url;
      try { url = URL.createObjectURL(b); } catch (_) { return; }
      d._objUrl = url;
      img.onload = () => {
        try { ltr.remove(); } catch (_) {}
        if (d.querySelector('img')) d.querySelector('img').remove();
        try {
          if (img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalWidth > img.naturalHeight) {
            d.classList.add('landscape');
          } else {
            d.classList.remove('landscape');
          }
        } catch (_) {}
        d.prepend(img);
      };
      img.onerror = () => {
        try { URL.revokeObjectURL(url); } catch (_) {}
        if (d._objUrl === url) d._objUrl = null;
      };
      img.src = url;
    };
    io.observe(d);
    return d;
  }

  return {
    getCover,
    saveCoverBlob,
    optimizeImageBlob,
    comicCover,
    pump,
    io,
    thumbFromBlob,
  };
}
