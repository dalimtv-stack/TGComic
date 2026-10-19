/**
 * Portadas de cómics: generación, optimización y nodos de UI.
 */
export function createCovers(state, d) {
  const {
    el, kv, zip,
    TgReader, getMsg, pageBlob, sniff, pagesOf,
    readProgress, isComicRead, stripExt,
  } = d;

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

  async function getCover(ch, f) {
    const key = `c:${ch.id}:${f.id}`;
    let b = await kv.get(key);
    if (b === 'none') b = undefined;
    if (!b) b = await enqueue(() => makeCover(ch, f, key));
    return b && b !== 'none' ? b : null;
  }

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

  async function optimizeImageBlob(blob, maxEdge = 320, quality = 0.72) {
    if (!blob || !blob.size) return null;
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
      const url = URL.createObjectURL(b);
      img.onload = () => {
        try { ltr.remove(); } catch (_) {}
        // Revocar URL anterior si se regenera la portada
        if (d._objUrl) { try { URL.revokeObjectURL(d._objUrl); } catch (_) {} }
        d._objUrl = url;
        d.prepend(img);
      };
      img.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
      img.src = url;
    };
    // Al quitar el nodo del DOM, liberar la URL
    try {
      const mo = new MutationObserver(() => {
        if (!document.contains(d) && d._objUrl) {
          try { URL.revokeObjectURL(d._objUrl); } catch (_) {}
          d._objUrl = null;
          mo.disconnect();
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
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
