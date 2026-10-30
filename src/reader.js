import { aiLabel, sourceNameOf } from './quality.js';
/**
 * Lector de cómics: modo página / vertical / horizontal, mosaico, gestos.
 * @param {object} state - referencias mutables del main (cleanup, reading, pump, stack, …)
 * @param {object} d - dependencias (el, pageBlob, prefs, progress, telegram, …)
 */
export function createReader(state, d) {
  const {
    el, $,
    pageBlob,
    getPageIndex, setPageIndex, setPagesTotal, setPageFormat, detectPageFormats,
    pref, setPref,
    resetMobileViewport,
    comicDisplayName, comicDisplay, stripExt,
    setLastRead,
    kv, fetchFiles, groupSeries, seriesOverrideFor,
    getMsg, openPages, saveCoverBlob,
    msg, alive, cancelled,
    show, go,
    modeBtn,
    pageCache,
    getCover,
    showComicInfo,
  } = d;
  const QSET = ['high', 'mid', 'low'];
  const FALLBACK = { high: ['high', 'mid', 'low'], mid: ['mid', 'high', 'low'], low: ['low', 'mid', 'high'] };
  const QNAME = { high: 'Alta', mid: 'Media', low: 'Baja' };
  const pickQuality = (f, want) => { const v = f?.variants; if (!v) return null; for (const q of FALLBACK[want] || FALLBACK.high) if (v[q]) return q; return null; };
  const variantFile = (f, q) => (q && f?.variants?.[q] ? { ...f, ...f.variants[q], id: f.variants[q].id } : f);
  // Iconos Material Design Icons: quality-high / quality-medium / quality-low
  const QICON = {
    high: 'M14.5,13.5H16.5V10.5H14.5M18,14A1,1 0 0,1 17,15H16.25V16.5H14.75V15H14A1,1 0 0,1 13,14V10A1,1 0 0,1 14,9H17A1,1 0 0,1 18,10M11,15H9.5V13H7.5V15H6V9H7.5V11.5H9.5V9H11M19,4H5C3.89,4 3,4.89 3,6V18A2,2 0 0,0 5,20H19A2,2 0 0,0 21,18V6C21,4.89 20.1,4 19,4Z',
    mid: 'M21,6V18A2,2 0 0,1 19,20H5A2,2 0 0,1 3,18V6A2,2 0 0,1 5,4H19A2,2 0 0,1 21,6M12,10C12,9.5 11.5,9 11,9H6.5C6,9 5.5,9.5 5.5,10V15H7V10.5H8V14H9.5V10.5H10.5V15H12V10M14.5,9A1,1 0 0,0 13.5,10V14A1,1 0 0,0 14.5,15H15.5V16.5H16.75V15H17.5A1,1 0 0,0 18.5,14V10A1,1 0 0,0 17.5,9H14.5M15,10.5H17V13.5H15V10.5Z',
    low: 'M14.5,13.5H16.5V10.5H14.5M18,14C18,14.6 17.6,15 17,15H16.25V16.5H14.75V15H14C13.4,15 13,14.6 13,14V10C13,9.4 13.4,9 14,9H17C17.6,9 18,9.4 18,10M19,4H5A2,2 0 0,0 3,6V18A2,2 0 0,0 5,20H19A2,2 0 0,0 21,18V6A2,2 0 0,0 19,4M11,13.5V15H6V9H7.5V13.5H11Z',
  };

  // Android: CSS + Fullscreen API (única forma de ocultar barra de sistema y del navegador).
  // El aviso del navegador al entrar es inevitable en Chrome Android; sin API las barras no se ocultan.
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  // Fullscreen nativo lo gestiona main.js a nivel de app (un solo aviso).
  // Aquí solo CSS de inmersión del lector.
  function enterReaderFullscreen() {
    try {
      document.documentElement.classList.add('reader-fs');
      document.body.classList.add('reader-fs');
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      document.documentElement.style.height = '100%';
      document.body.style.height = '100%';
    } catch (_) {}
  }
  function exitReaderFullscreen() {
    try {
      document.documentElement.classList.remove('reader-fs');
      document.body.classList.remove('reader-fs');
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      document.documentElement.style.height = '';
      document.body.style.height = '';
    } catch (_) {}
    // No salir del Fullscreen nativo: la app Android sigue a pantalla completa
  }
  function sizeReaderEl(rd) {
    if (!rd) return;
    try {
      const w = Math.round(window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth);
      const h = Math.round(window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight);
      rd.style.width = w + 'px';
      rd.style.height = h + 'px';
      rd.style.maxWidth = w + 'px';
      rd.style.maxHeight = h + 'px';
      rd.style.top = '0';
      rd.style.left = '0';
    } catch (_) {}
  }

  function networkPreloadRadius() {
    try {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c?.saveData) return 1;
      const t = String(c?.effectiveType || '').toLowerCase();
      if (t.includes('2g') || t === 'slow-2g') return 1;
      if (t.includes('3g')) return 1;
      // 4g / wifi / unknown
      return 2;
    } catch {
      return 2;
    }
  }


  /** Detecta viñetas por medianiles (filas/columnas de baja variación). Devuelve rects normalizados 0–1. */
  async function detectPanelsFromUrl(url) {
    try {
      const im = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const maxW = 360;
      const scale = Math.min(1, maxW / Math.max(1, im.naturalWidth));
      const w = Math.max(32, Math.round(im.naturalWidth * scale));
      const h = Math.max(32, Math.round(im.naturalHeight * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
        lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      }
      const rowVar = new Float32Array(h);
      for (let y = 0; y < h; y++) {
        let sum = 0, sum2 = 0;
        const off = y * w;
        for (let x = 0; x < w; x++) {
          const v = lum[off + x];
          sum += v; sum2 += v * v;
        }
        const mean = sum / w;
        rowVar[y] = sum2 / w - mean * mean;
      }
      const med = (() => {
        const a = Array.from(rowVar).sort((a, b) => a - b);
        return a[Math.floor(a.length / 2)] || 1;
      })();
      const gutterRow = (y) => rowVar[y] < med * 0.18;
      // bandas de contenido
      const bands = [];
      let y = 0;
      while (y < h) {
        while (y < h && gutterRow(y)) y++;
        if (y >= h) break;
        const y0 = y;
        while (y < h && !gutterRow(y)) y++;
        const y1 = y;
        if (y1 - y0 > h * 0.04) bands.push([y0, y1]);
      }
      if (bands.length < 1) return [];

      const panels = [];
      for (const [y0, y1] of bands) {
        const bh = y1 - y0;
        const colVar = new Float32Array(w);
        for (let x = 0; x < w; x++) {
          let sum = 0, sum2 = 0;
          for (let yy = y0; yy < y1; yy++) {
            const v = lum[yy * w + x];
            sum += v; sum2 += v * v;
          }
          const mean = sum / bh;
          colVar[x] = sum2 / bh - mean * mean;
        }
        const cmed = (() => {
          const a = Array.from(colVar).sort((a, b) => a - b);
          return a[Math.floor(a.length / 2)] || 1;
        })();
        const gutterCol = (x) => colVar[x] < cmed * 0.18;
        let x = 0;
        const cols = [];
        while (x < w) {
          while (x < w && gutterCol(x)) x++;
          if (x >= w) break;
          const x0 = x;
          while (x < w && !gutterCol(x)) x++;
          const x1 = x;
          if (x1 - x0 > w * 0.06) cols.push([x0, x1]);
        }
        if (!cols.length) cols.push([0, w]);
        for (const [x0, x1] of cols) {
          panels.push({
            x: x0 / w,
            y: y0 / h,
            w: (x1 - x0) / w,
            h: (y1 - y0) / h,
          });
        }
      }
      // Filtrar viñetas minúsculas; si solo 1 casi a página completa → sin panel
      const filtered = panels.filter((p) => p.w * p.h > 0.04);
      if (filtered.length <= 1) {
        const p = filtered[0];
        if (!p || (p.w > 0.85 && p.h > 0.85)) return [];
      }
      return filtered;
    } catch {
      return [];
    }
  }

  async function resolveQueue(ch, f) {
    try {
      let files = (await kv.get('f:' + ch.id)) || [];
      if (!files.length) files = await fetchFiles(ch);
      for (const { files: fs, label } of groupSeries(files, ch.name, seriesOverrideFor(ch))) {
        if (fs.some((x) => String(x.id) === String(f.id))) {
          // Mismo orden que la vista de la serie (preferencia nombre / fecha / manual del usuario)
          try {
            const sorter = globalThis.__tgSortSeriesFiles;
            if (typeof sorter === 'function') return sorter(ch, label, fs);
          } catch (_) {}
          // Siempre cola de la serie (aunque tenga 1): evita saltar a otro cómic del canal.
          // Mismo orden que groupSeries (el de la vista de la serie): no reordenar por nº de '#',
          // porque los cómics sin '#' en el nombre acababan al final y se saltaban números.
          return fs.slice();
        }
      }
      return files.slice(); // ya ordenado por nombre (natural) al listar el canal
    } catch { return [f]; }
  }

  function openComic(ch, f, queue, opts = {}) {
    const start = async (e) => {
      e._isComic = true;
      state.reading = true;
      const ac = { cancelled: false };
      let rdClean = null;
      state.cleanup = () => { ac.cancelled = true; state.reading = false; state.pump(); rdClean?.(); };
      msg('Abriendo…');
      try {
        const status = (t) => { if (!cancelled(ac) && alive(e)) msg(t); };
        // La cola llega ya en el orden visible (nombre / fecha / manual) desde la vista; no reordenar aquí.
        const list = queue && queue.length ? queue : await resolveQueue(ch, f);
        // Si f es una versión oculta (p. ej. desde "Seguir leyendo"), usar la entrada principal que la agrupa
        try {
          const holder = list.find((x) => (x?.variants && Object.values(x.variants).some((v) => String(v?.id) === String(f.id)))
            || (Array.isArray(x?.ai) && x.ai.some((v) => String(v?.id) === String(f.id))));
          if (holder && String(holder.id) !== String(f.id)) f = { ...holder };
          else {
            const same = list.find((x) => String(x.id) === String(f.id));
            if (same?.variants && !f.variants) f = { ...f, variants: same.variants };
            if (same?.ai && !f.ai) f = { ...f, ai: same.ai };
          }
        } catch (_) {}
        setLastRead(ch, f);
        const idx = Math.max(0, list.findIndex((x) => String(x.id) === String(f.id)));
        // Preferir entrada fresca del listado (tamaño puede haber cambiado al resubir en Telegram)
        try {
          const fresh = list.find((x) => String(x.id) === String(f.id));
          if (fresh?.size) f = { ...f, size: fresh.size, name: fresh.name || f.name, caption: fresh.caption ?? f.caption };
        } catch (_) {}
        // Calidad: la pedida al cambiar en el visor, o la preferida; progreso siempre por la entrada principal (f)
        const wantQ = opts.quality || pref('quality', 'high');
        let curQ = pickQuality(f, wantQ);
        // Versión mejorada con IA elegida en el visor (opts.ai = id del archivo)
        const aiFile = () => (opts.ai != null && Array.isArray(f.ai) ? f.ai.find((v) => String(v.id) === String(opts.ai)) : null);
        const pickSrc = () => { const a = aiFile(); return a ? { ...f, ...a, id: a.id } : variantFile(f, curQ); };
        let src = pickSrc();
        const openArc = async () => {
          const m0 = await getMsg(ch, src, { force: true });
          let size = Number(src.size) || 0;
          try {
            if (m0?.document?.size != null) size = Number(m0.document.size.toString()) || size;
          } catch (_) {}
          return openPages(m0, size, status, ac);
        };
        let arc;
        try {
          arc = await openArc();
        } catch (errOpen) {
          const em = String(errOpen?.message || errOpen || '');
          if (!/central directory|end of central|invalid zip|corrupt|bad zip/i.test(em)) throw errOpen;
          // Caché de mensaje/páginas obsoleta tras re-subida: limpiar y reintentar
          try { await pageCache?.clearComic?.(ch.id, src.id); } catch (_) {}
          try {
            const files = await fetchFiles(ch);
            const fresh2 = files.find((x) => String(x.id) === String(f.id));
            if (fresh2) {
              f = { ...f, size: fresh2.size, name: fresh2.name || f.name, caption: fresh2.caption ?? f.caption, variants: fresh2.variants, ai: fresh2.ai };
              curQ = pickQuality(f, wantQ);
              src = pickSrc();
            }
          } catch (_) {}
          status('Reintentando apertura…');
          arc = await openArc();
        }
        if (cancelled(ac) || !alive(e)) { try { arc.close(); } catch (_) {} return; }
        if (!arc.pages.length) return msg('No se encontraron imágenes.');
        // Cambio de calidad: si la otra versión tiene distinto nº de páginas, mantener la posición proporcional
        if (opts.fromTotal && opts.fromTotal !== arc.pages.length && arc.pages.length > 1) {
          const ratio = opts.fromTotal > 1 ? (opts.fromIdx || 0) / (opts.fromTotal - 1) : 0;
          setPageIndex(ch.id, f.id, Math.max(0, Math.min(arc.pages.length - 1, Math.round(ratio * (arc.pages.length - 1)))));
        }
        pageBlob(arc.pages[0]).then((b) => saveCoverBlob(ch, f, b, { auto: true })).catch(() => {});
        const aiOn = aiFile();
        rdClean = reader(f, arc.pages, arc, { ch, list, idx, src, q: aiOn ? null : curQ, aiId: aiOn ? aiOn.id : null });
      } catch (err) {
        if (err?.cancelled || cancelled(ac)) return;
        if (alive(e)) msg('Error: ' + err.message);
      }
    };
    const comicTitle = comicDisplayName(ch, f, comicDisplay(f.name, ch.name) || stripExt(f.name));
    if (opts.replace && state.stack.length) {
      state.cleanup?.(); state.cleanup = null;
      state.stack.pop();
      state.stack.push({ title: comicTitle, render: start, _isComic: true });
      try { history.replaceState(null, ''); } catch (_) {}
      show();
    } else {
      go(comicTitle, start);
    }
  }

  // Play activo al saltar al siguiente cómic desde la pantalla final → seguir reproduciendo
  let autoCarryNext = false;

  function reader(f, pages, zr, ctx) {
    const chId = ctx?.ch?.id;
    const srcId = ctx?.src?.id ?? f.id; // caché de páginas: por versión (las imágenes difieren)
    const savePage = (i) => { try { maybePreloadNext(i); } catch (_) {} if (chId != null) { setPageIndex(chId, f.id, i); try { setLastRead(ctx.ch, f); } catch (_) {} } }; // progreso: unificado por la entrada principal
    const qVariants = f.variants && Object.keys(f.variants).length > 1 ? f.variants : null;
    if (chId != null) {
      setPagesTotal(chId, f.id, pages.length);
      const fmt = detectPageFormats(pages);
      if (fmt) setPageFormat(chId, f.id, fmt);
    }
    let n = Math.min(chId != null ? getPageIndex(chId, f.id) : 0, pages.length - 1);
    const urls = new Map(); // i → Promise<string objectURL>
    const blobFor = async (i) => {
      if (i < 0 || i >= pages.length) return null;
      // Caché persistente
      if (pageCache && chId != null) {
        try {
          const hit = await pageCache.get(chId, srcId, i);
          if (hit) return hit;
        } catch (_) {}
      }
      const b = await pageBlob(pages[i]);
      if (b && pageCache && chId != null) {
        pageCache.set(chId, srcId, i, b).catch(() => {});
      }
      return b;
    };
    const load = (i) => {
      if (i < 0 || i >= pages.length) return null;
      if (!urls.has(i)) {
        const p = blobFor(i).then((b) => {
          if (!b) throw new Error('sin blob');
          return URL.createObjectURL(b);
        });
        p.catch(() => urls.delete(i));
        urls.set(i, p);
      }
      return urls.get(i);
    };
    const drop = (i) => {
      const p = urls.get(i);
      if (p) {
        p.then((u) => { try { URL.revokeObjectURL(u); } catch (_) {} }, () => {});
        urls.delete(i);
      }
    };
    const dropAll = () => {
      for (const i of [...urls.keys()]) drop(i);
      urls.clear();
    };
    const preloadAround = async (center, token, mine) => {
      const r = networkPreloadRadius();
      const order = [];
      for (let d = 1; d <= r; d++) {
        order.push(center + d, center - d);
      }
      // +1 extra en wifi agresivo ya cubierto por r=2
      for (const i of order) {
        if (token !== mine) return;
        if (i < 0 || i >= pages.length) continue;
        try { await load(i); } catch (_) {}
      }
    };
    const hasNext = !!(ctx?.list && ctx.idx >= 0 && ctx.idx < ctx.list.length - 1);
    const openNext = () => {
      if (!hasNext) return;
      savePage(pages.length - 1);
      closeNextCard();
      openComic(ctx.ch, ctx.list[ctx.idx + 1], ctx.list, { replace: true });
    };

    // ── Pantalla final: portada + título del siguiente, botón y avance automático ──
    const NEXT_SECS = 8;
    let nextCard = null, nextCardT = 0;
    const closeNextCard = () => {
      clearInterval(nextCardT); nextCardT = 0;
      try { nextCard?.remove(); } catch (_) {}
      nextCard = null;
    };
    const nextCardOpen = () => !!nextCard;
    const showNextCard = (opts = {}) => {
      if (!hasNext || nextCard) return;
      const host = document.getElementById('rd');
      if (!host) return openNext();
      const nf = ctx.list[ctx.idx + 1];
      const title = comicDisplayName(ctx.ch, nf, comicDisplay(nf.name, ctx.ch.name) || stripExt(nf.name));
      const ov = el('div', 'next-card');
      const box = el('div', 'next-card-box');
      const cov = el('div', 'next-card-cover');
      box.append(el('div', 'next-card-lbl', 'Siguiente'), cov, el('div', 'next-card-title', title));
      const go = el('button', 'btn next-btn', 'Leer ahora');
      const stay = el('button', 'btn next-card-stay', 'Quedarme aquí');
      const cnt = el('div', 'next-card-count');
      box.append(go, stay, cnt);
      ov.append(box);
      ['click', 'pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown', 'mouseup'].forEach((t) =>
        ov.addEventListener(t, (ev) => ev.stopPropagation(), { passive: t !== 'click' && t !== 'wheel' ? true : false }));
      ov.addEventListener('click', (ev) => { if (ev.target === ov) closeNextCard(); });
      go.onclick = (ev) => { ev.stopPropagation(); if (opts.auto) autoCarryNext = true; openNext(); };
      stay.onclick = (ev) => { ev.stopPropagation(); closeNextCard(); };
      host.append(ov);
      nextCard = ov;
      try { go.focus({ preventScroll: true }); } catch (_) {}
      if (typeof getCover === 'function') {
        Promise.resolve(getCover(ctx.ch, nf)).then((b) => {
          if (!b || nextCard !== ov) return;
          const im = el('img'); im.alt = ''; im.draggable = false;
          const u = URL.createObjectURL(b);
          im.onload = im.onerror = () => setTimeout(() => { try { URL.revokeObjectURL(u); } catch (_) {} }, 1000);
          im.src = u; cov.append(im); cov.classList.add('has');
        }).catch(() => {});
      }
      let left = opts.secs || NEXT_SECS;
      cnt.textContent = 'Empieza en ' + left + ' s';
      nextCardT = setInterval(() => {
        if (nextCard !== ov) return;
        if (document.visibilityState !== 'visible') return; // no avanzar con la app en segundo plano
        left -= 1;
        if (left <= 0) { if (opts.auto) autoCarryNext = true; openNext(); return; }
        cnt.textContent = 'Empieza en ' + left + ' s';
      }, 1000);
    };

    // ── Cargar por adelantado las primeras páginas del siguiente cómic ──
    let nextPreloaded = false;
    const preloadNextComic = async () => {
      if (nextPreloaded || !hasNext || !pageCache || chId == null) return;
      if (networkPreloadRadius() < 2) return; // con conexión lenta o ahorro de datos, no
      nextPreloaded = true;
      try {
        const nf = ctx.list[ctx.idx + 1];
        const nsrc = variantFile(nf, pickQuality(nf, pref('quality', 'high')));
        // RAR/CBR obliga a descargar el archivo entero: no adelantar
        if (/\.(cbr|rar)$/i.test(String(nsrc.name || nf.name || ''))) return;
        const startAt = Math.max(0, getPageIndex(chId, nf.id) || 0);
        const want = [startAt, startAt + 1, startAt + 2];
        const missing = [];
        for (const i of want) {
          try { if (!(await pageCache.get(chId, nsrc.id, i))) missing.push(i); } catch (_) { missing.push(i); }
        }
        if (!missing.length) return;
        const m0 = await getMsg(ctx.ch, nsrc, {});
        let size = Number(nsrc.size) || 0;
        try { if (m0?.document?.size != null) size = Number(m0.document.size.toString()) || size; } catch (_) {}
        const ac2 = { cancelled: false };
        const arc2 = await openPages(m0, size, () => {}, ac2);
        try {
          for (const i of missing) {
            if (i >= arc2.pages.length) break;
            const b = await pageBlob(arc2.pages[i]);
            if (b) await pageCache.set(chId, nsrc.id, i, b);
          }
        } finally {
          try { Promise.resolve(arc2.close()).catch(() => {}); } catch (_) {}
        }
      } catch (e) { console.warn('[visor] precarga siguiente', e?.message || e); }
    };
    const maybePreloadNext = (i) => {
      if (hasNext && i >= pages.length - 3) setTimeout(() => { preloadNextComic(); }, 1500);
    };

    const mount = () => {
      n = Math.min(chId != null ? getPageIndex(chId, f.id) : (n || 0), pages.length - 1);
      let mode = pref('mode', 'page');
      if (mode !== 'page' && mode !== 'vertical' && mode !== 'horizontal' && mode !== 'panel') mode = 'page';
      const vert = mode === 'vertical';
      const horiz = mode === 'horizontal';
      const panelMode = mode === 'panel';
      const continuous = vert || horiz;
      let token = 0, observers = [], footObs = null;
      const rd = el('div'); rd.id = 'rd';
      try { window.dispatchEvent(new CustomEvent('tgcomic:reader', { detail: { open: true } })); } catch (_) {}
      // Barra superior: título + estado de modo
      const top = el('div', 'bar topbar');
      const modeName = { page: 'Página', vertical: 'Vertical', horizontal: 'Horizontal', panel: 'Viñeta' };
      const fitName = { screen: 'Pantalla', width: 'Ancho' };
      const status = el('div', 'rd-status');
      const updateStatus = () => {
        const m = pref('mode', 'page');
        const f = pref('fit', 'screen') === 'width' ? 'width' : 'screen';
        status.replaceChildren();
        const dot = () => { const s = el('span', 'rd-dot'); s.textContent = '●'; return s; };
        const bit = (label) => {
          const w = el('span', 'rd-status-bit');
          w.append(document.createTextNode(label + ' '), dot());
          return w;
        };
        status.append(bit('Modo: ' + (modeName[m] || m)));
        if (m !== 'page') status.append(bit('Ajuste: ' + fitName[f]));
        else status.append(bit('Ajuste: ' + fitName[f]));
      };
      updateStatus();
      const titleCol = el('div', 'rd-titlecol');
      const rdTitle = (ctx?.ch)
        ? comicDisplayName(ctx.ch, f, comicDisplay(f.name, ctx.ch.name) || stripExt(f.name))
        : stripExt(f.name);
      titleCol.append(el('span', 'ttl', rdTitle), status);
      top.append(titleCol);
      // Barra inferior: controles
      const bot = el('div', 'bar botbar');
      const back = el('button', 'btn', '‹');
      back.setAttribute('aria-label', 'Atrás');
      back.onclick = () => history.back();
      const mb = modeBtn(() => {
        savePage(n);
        unmount();
        unmount = mount();
      });
      const gridBtn = el('button', 'btn grid-btn', '▦');
      gridBtn.setAttribute('aria-label', 'Mosaico de páginas');
      gridBtn.title = 'Páginas';
      const cnt = el('span', 'cnt');
      const setCount = () => (cnt.textContent = `${n + 1} / ${pages.length}`);
      const cluster = el('div', 'bot-cluster');
      const botLeft = el('div', 'bot-side bot-left');
      const botCenter = el('div', 'bot-side bot-center');
      const botRight = el('div', 'bot-side bot-right');
      botLeft.append(back, mb);
      botCenter.append(gridBtn);
      cluster.append(botLeft, botCenter, botRight);
      bot.append(cluster);
      document.body.append(rd);
      // Botones de calidad (Alta / Media / Baja) a la derecha del de doble página
      const aiList = Array.isArray(f.ai) && f.ai.length ? f.ai : null;
      if (qVariants || aiList) {
        const qGroup = el('div', 'q-group');
        if (qVariants) for (const q of QSET) {
          const b = el('button', 'btn q-btn' + (ctx?.q === q ? ' on' : ''));
          b.type = 'button';
          b.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${QICON[q]}"/></svg>`;
          const exists = !!qVariants[q];
          b.title = exists ? ('Calidad ' + QNAME[q]) : ('Calidad ' + QNAME[q] + ' (no disponible)');
          b.setAttribute('aria-label', b.title);
          b.setAttribute('aria-pressed', ctx?.q === q ? 'true' : 'false');
          b.disabled = !exists;
          b.onclick = (ev) => {
            try { ev.stopPropagation(); } catch (_) {}
            if (!exists || ctx?.q === q) return;
            setPref('quality', q);
            savePage(n);
            openComic(ctx.ch, f, ctx.list, { replace: true, quality: q, fromTotal: pages.length, fromIdx: n });
          };
          qGroup.append(b);
        }
        // Botón IA: listado para elegir la versión mejorada
        if (aiList) {
          const ab = el('button', 'btn q-btn ai-btn' + (ctx?.aiId != null ? ' on' : ''));
          ab.type = 'button';
          ab.title = 'Versión mejorada con IA';
          ab.setAttribute('aria-label', ab.title);
          ab.setAttribute('aria-haspopup', 'menu');
          const ico = el('span', 'ai-ico');
          ab.append(ico);
          const reopen = (aiId) => {
            savePage(n);
            openComic(ctx.ch, f, ctx.list, { replace: true, ai: aiId, quality: ctx?.q || undefined, fromTotal: pages.length, fromIdx: n });
          };
          ab.onclick = (ev) => {
            try { ev.stopPropagation(); } catch (_) {}
            if (document.querySelector('.ai-menu')) return;
            const ov = el('div', 'ai-menu');
            const box = el('div', 'ai-menu-box');
            box.setAttribute('role', 'menu');
            box.append(el('div', 'ai-menu-ttl', 'Versión del cómic'));
            const close = () => { try { ov.remove(); } catch (_) {} };
            const item = (label, active, onPick) => {
              const it = el('button', 'btn ai-menu-item' + (active ? ' on' : ''), label);
              it.type = 'button';
              it.setAttribute('role', 'menuitemradio');
              it.setAttribute('aria-checked', active ? 'true' : 'false');
              it.onclick = (e2) => { e2.stopPropagation(); close(); if (!active) onPick(); };
              box.append(it);
            };
            item('Original', ctx?.aiId == null, () => reopen(null));
            for (const v of aiList) item(aiLabel(sourceNameOf(v)), String(ctx?.aiId) === String(v.id), () => reopen(v.id));
            ['click', 'pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown', 'mouseup'].forEach((t) =>
              ov.addEventListener(t, (e3) => e3.stopPropagation(), { passive: t !== 'click' && t !== 'wheel' }));
            ov.addEventListener('click', (e4) => { if (e4.target === ov) close(); });
            ov.append(box);
            rd.append(ov);
          };
          qGroup.append(ab);
        }
        rd.append(qGroup);
      }
      // ---- Reproducción automática (Play): pasa de página sola cada N segundos ----
      const PLAY_D = 'M8,5.14V19.14L19,12.14L8,5.14Z'; // mdi-play
      const PAUSE_D = 'M14,19H18V5H14M6,19H10V5H6V19Z'; // mdi-pause
      const iconSvg = (d, s = 22) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
      let autoOn = false, autoT = 0, autoStep = null, autoRaf = 0, autoFinish = null;
      const autoMs = () => Math.max(2, Math.min(120, +(pref('autoPlaySec', '7') || 7))) * 1000;
      const playBtn = el('button', 'btn play-fab');
      playBtn.type = 'button';
      const paintPlay = () => {
        playBtn.innerHTML = iconSvg(autoOn ? PAUSE_D : PLAY_D);
        playBtn.title = autoOn ? 'Pausar reproducción automática' : 'Reproducir automáticamente';
        playBtn.setAttribute('aria-label', playBtn.title);
        playBtn.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
        playBtn.classList.toggle('on', autoOn);
      };
      const autoCancelAnim = () => {
        if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = 0; }
        const fin = autoFinish;
        autoFinish = null;
        if (fin) fin();
      };
      /** Desplazamiento suave (ease in-out). En #rd desactiva el scroll-snap mientras dura. */
      const animateScroll = (target, prop, to, dur) => new Promise((resolve) => {
        autoCancelAnim();
        const from = target[prop];
        const delta = to - from;
        if (!Number.isFinite(delta) || Math.abs(delta) < 1) { resolve(); return; }
        const time = dur || Math.min(1300, Math.max(650, 400 + Math.abs(delta) * 0.45));
        const isRd = target === rd;
        const prevSnap = isRd ? rd.style.scrollSnapType : '';
        const prevBeh = target.style.scrollBehavior;
        if (isRd) rd.style.scrollSnapType = 'none';
        target.style.scrollBehavior = 'auto';
        const t0 = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        autoFinish = () => {
          autoFinish = null;
          if (isRd) rd.style.scrollSnapType = prevSnap;
          target.style.scrollBehavior = prevBeh;
          resolve();
        };
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / time);
          target[prop] = from + delta * ease(t);
          if (t < 1) autoRaf = requestAnimationFrame(tick);
          else { autoRaf = 0; const fin = autoFinish; if (fin) fin(); }
        };
        autoRaf = requestAnimationFrame(tick);
      });
      const autoSchedule = () => {
        clearTimeout(autoT);
        if (!autoOn) return;
        autoT = setTimeout(autoTick, autoMs());
      };
      const autoStop = () => {
        autoOn = false;
        clearTimeout(autoT);
        autoCancelAnim();
        paintPlay();
      };
      const autoTick = async () => {
        if (!autoOn) return;
        if (document.hidden || document.querySelector('.mosaic') || !document.getElementById('rd')) { autoSchedule(); return; }
        let more = true;
        try { more = (await autoStep?.()) !== false; } catch (e) { console.warn('[autoplay]', e); }
        if (!autoOn) return;
        if (!more) { // fin del cómic: pantalla final como al pasar a mano; sin tocar nada, a los 3 s sigue
          autoStop();
          if (hasNext) { closeNextCard(); showNextCard({ auto: true, secs: 3 }); }
          return;
        }
        autoSchedule();
      };
      const autoStart = () => { autoOn = true; paintPlay(); autoSchedule(); };
      // Si el usuario interactúa (arrastra, rueda, toca), se reinicia la cuenta atrás
      const autoBump = () => { if (!autoOn) return; autoCancelAnim(); autoSchedule(); };
      rd.addEventListener('pointerdown', autoBump, { passive: true });
      rd.addEventListener('wheel', autoBump, { passive: true });
      playBtn.onclick = (ev) => {
        try { ev.stopPropagation(); } catch (_) {}
        if (autoOn) autoStop(); else autoStart();
      };
      paintPlay();
      if (autoCarryNext) { autoCarryNext = false; setTimeout(() => { if (document.getElementById('rd')) autoStart(); }, 0); }

      // Ajustes de reproducción automática (engranaje a la izquierda del Play)
      const COG_D = 'M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z';
      const cfgBtn = el('button', 'btn auto-cfg-fab');
      cfgBtn.type = 'button';
      cfgBtn.innerHTML = iconSvg(COG_D);
      cfgBtn.title = 'Ajustes de reproducción automática';
      cfgBtn.setAttribute('aria-label', cfgBtn.title);
      cfgBtn.onclick = (ev) => {
        try { ev.stopPropagation(); } catch (_) {}
        const wasOn = autoOn;
        if (wasOn) autoStop();
        document.querySelector('.rd-auto-cfg')?.remove();
        const overlay = el('div', 'rd-auto-cfg');
        const box = el('div', 'rd-auto-cfg-box');
        box.append(el('div', 'rd-auto-cfg-title', 'Reproducción automática'));
        box.append(el('p', 'rd-auto-cfg-hint', 'Segundos entre páginas (2–120)'));
        const inp = el('input', 'edit-input');
        inp.type = 'number';
        inp.min = '2';
        inp.max = '120';
        inp.step = '1';
        inp.value = String(Math.max(2, Math.min(120, +(pref('autoPlaySec', '7') || 7))));
        box.append(inp);
        const ok = el('button', 'btn edit-save', 'Aceptar');
        ok.onclick = () => {
          let n = parseInt(inp.value, 10);
          if (!Number.isFinite(n)) n = 7;
          n = Math.max(2, Math.min(120, n));
          try { setPref('autoPlaySec', String(n)); } catch (_) {
            try { localStorage.setItem('pref:autoPlaySec', String(n)); } catch (_) {}
          }
          overlay.remove();
          if (wasOn) {
            autoOn = true;
            paintPlay();
            autoSchedule();
          }
        };
        box.append(ok);
        overlay.append(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) ok.click(); });
        rd.append(overlay);
        try { inp.focus(); inp.select(); } catch (_) {}
      };
      // Información del cómic (entre ajustes y botón IA cuando exista)
      const infoBtn = el('button', 'btn rd-info-btn');
      infoBtn.type = 'button';
      infoBtn.title = 'Información del cómic';
      infoBtn.setAttribute('aria-label', infoBtn.title);
      infoBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z"/></svg>';
      infoBtn.onclick = (ev) => {
        try { ev.stopPropagation(); } catch (_) {}
        try {
          if (typeof showComicInfo !== 'function') return;
          // Mantener la página visible debajo: solo subir z-index del frame
          showComicInfo(ctx.ch, f);
          const styleFrame = () => {
            document.querySelectorAll('.info-frame, .edit-frame, .desc-panel').forEach((node) => {
              try {
                node.style.zIndex = '200';
                node.style.position = 'fixed';
                // Fondo semitransparente para ver la página detrás
                if (node.classList.contains('info-frame') || node.classList.contains('edit-frame')) {
                  const bg = getComputedStyle(node).backgroundColor || '';
                  if (!node.dataset.tgBg) {
                    node.dataset.tgBg = '1';
                    // Si el frame es opaco de borde a borde, suavizar el overlay exterior
                    node.style.background = 'rgba(0,0,0,.45)';
                  }
                  // Caja interior opaca si existe
                  const box = node.querySelector('.info-box, .edit-box, .info-panel, .edit-panel, .sheet-box');
                  if (box && !box.dataset.tgSolid) {
                    box.dataset.tgSolid = '1';
                    const cs = getComputedStyle(box);
                    if (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') {
                      box.style.background = 'var(--card, #1b1c20)';
                    }
                  }
                }
              } catch (_) {}
            });
          };
          requestAnimationFrame(() => {
            styleFrame();
            setTimeout(styleFrame, 30);
            setTimeout(styleFrame, 120);
          });
        } catch (e) { console.warn('[reader] info', e); }
      };
      rd.append(cfgBtn, infoBtn, playBtn);
      document.body.style.overflow = 'hidden';
      try { enterReaderFullscreen(); } catch (_) {}
      try { sizeReaderEl(rd); } catch (_) {}
      // Android: franja invisible a la izquierda para salir del lector
      if (isAndroid) {
        const edgeBack = el('div', 'edge-back');
        edgeBack.setAttribute('aria-hidden', 'true');
        let ebx = null, eby = 0;
        edgeBack.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) { ebx = null; return; }
          ebx = e.touches[0].clientX;
          eby = e.touches[0].clientY;
        }, { passive: true });
        edgeBack.addEventListener('touchmove', (e) => {
          if (ebx == null || !e.touches[0]) return;
          const dx = e.touches[0].clientX - ebx;
          const dy = e.touches[0].clientY - eby;
          if (dx > 12 && Math.abs(dx) > Math.abs(dy)) {
            try { e.preventDefault(); } catch (_) {}
          }
        }, { passive: false });
        edgeBack.addEventListener('touchend', (e) => {
          if (ebx == null) return;
          const t = e.changedTouches?.[0];
          if (!t) { ebx = null; return; }
          const dx = t.clientX - ebx;
          const dy = t.clientY - eby;
          ebx = null;
          // Android: el gesto del sistema ya hace history.back(); duplicarlo cierra visor + carpeta
          if (isAndroid) return;
          if (dx > 48 && Math.abs(dy) < 110) history.back();
        }, { passive: true });
        rd.append(edgeBack);
      }
      const uiHideMs = () => {
        const sec = Math.max(3, Math.min(120, +(pref('uiHideSec', '15') || 15)));
        return sec * 1000;
      };
      // --- Auto-ocultar menús: UN solo temporizador y UNA sola ruta para mostrar/ocultar ---
      let uiTimer = null;
      let uiHover = false;
      const armUiHide = () => {
        clearTimeout(uiTimer);
        uiTimer = setTimeout(() => {
          if (!uiHover && !document.querySelector('.mosaic')) rd.classList.add('ui-off');
        }, uiHideMs());
      };
      const pokeUI = () => { rd.classList.remove('ui-off'); armUiHide(); };
      const toggleUI = () => {
        if (rd.classList.contains('ui-off')) pokeUI();
        else { clearTimeout(uiTimer); rd.classList.add('ui-off'); }
      };
      // Solo ratón real (en táctil el mouseenter emulado dejaba el timer cancelado para siempre)
      for (const node of [cluster, bot]) {
        node.addEventListener('pointerenter', (e) => {
          if (e.pointerType !== 'mouse') return;
          uiHover = true;
          rd.classList.remove('ui-off');
          clearTimeout(uiTimer);
        });
        node.addEventListener('pointerleave', (e) => {
          if (e.pointerType !== 'mouse') return;
          uiHover = false;
          armUiHide();
        });
      }
      armUiHide();
      // rd.className = ... borra 'ui-off'; esta utilidad lo conserva
      const setRdClass = (cls) => {
        const off = rd.classList.contains('ui-off');
        rd.className = cls;
        if (off) rd.classList.add('ui-off');
      };

      const showMosaic = (ev) => {
        try { ev?.preventDefault?.(); ev?.stopPropagation?.(); } catch (_) {}
        pokeUI();
        document.querySelectorAll('.mosaic').forEach((x) => x.remove());
        const overlay = el('div', 'mosaic');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:200;touch-action:none;';
        let cellsLive = false;
        setTimeout(() => { cellsLive = true; }, 320);
        const blockGhost = (e) => {
          if (!cellsLive) { try { e.preventDefault(); e.stopPropagation(); } catch (_) {} }
        };
        overlay.addEventListener('touchstart', blockGhost, { capture: true, passive: false });
        overlay.addEventListener('click', blockGhost, { capture: true });
        const head = el('div', 'mosaic-head');
        head.append(el('span', '', 'Páginas'), el('button', 'btn', 'Cerrar'));
        head.querySelector('button').onclick = (e) => {
          try { e.stopPropagation(); } catch (_) {}
          overlay.remove();
        };
        const g = el('div', 'mosaic-grid');
        const thumbs = [];
        // En modo doble página n es la página derecha; resaltar ambas
        const hiL = (pref('mode', 'page') === 'page' && pref('spread', '0') === '1' && n > 0) ? n - 1 : n;
        const hiR = n;
        for (let i = 0; i < pages.length; i++) {
          const on = (i === hiL || i === hiR) ? ' on' : '';
          const cell = el('button', 'mosaic-cell' + on);
          cell.type = 'button';
          cell.append(el('span', 'mosaic-num', String(i + 1)));
          const ph = el('div', 'mosaic-ph');
          cell.append(ph);
          cell.onclick = (e) => {
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            if (!cellsLive) return;
            overlay.remove();
            try { goToPage(i); } catch (_) {}
          };
          g.append(cell);
          thumbs.push({ i, ph, cell });
        }
        overlay.append(head, g);
        overlay.addEventListener('click', (ev2) => { if (ev2.target === overlay) overlay.remove(); });
        // body: funciona en Página y en Vertical/Horizontal (absolute dentro de #rd fallaba al hacer scroll)
        document.body.append(overlay);
        try {
          const cur = thumbs.find((t) => t.i === hiR) || thumbs.find((t) => t.i === hiL);
          if (cur?.cell) requestAnimationFrame(() => { try { cur.cell.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {} });
        } catch (_) {}
        (async () => {
          for (const { i, ph } of thumbs) {
            if (!overlay.isConnected) return;
            try {
              const u = await load(i);
              if (!u || !overlay.isConnected) continue;
              const im = el('img');
              im.alt = String(i + 1);
              im.decoding = 'async';
              im.loading = 'lazy';
              im.src = u;
              ph.replaceChildren(im);
            } catch (_) {}
            if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
          }
        })();
      };
      const bindGridBtn = () => {
        gridBtn.onclick = showMosaic;
        gridBtn.onpointerup = (ev) => {
          if (ev.button != null && ev.button !== 0) return;
          showMosaic(ev);
        };
      };
      bindGridBtn();

      /** Modo página: soltar tras arrastrar cambia de página. Vertical/Horizontal: arrastrar desplaza el scroll. */
      /**
       * scrollWhileDrag: true = arrastrar desplaza el scroll (vert/horiz).
       * opts.onDragStart/onDragEnd: p.ej. syncLock para que el scroll handler no luche.
       */
      const bindMousePageDrag = (getAxis, goPrev, goNext, scrollWhileDrag, opts = {}) => {
        let start = null;
        let dragging = false;
        let raf = 0;
        let pending = null;
        let samples = [];
        // Elemento que realmente hace scroll (modo página: .page-host; vertical/horizontal: #rd)
        const scr = () => (typeof opts.scroller === 'function' ? (opts.scroller() || rd) : rd);
        const onDown = (e) => {
          if (e.button !== 0) return;
          if (e.target.closest?.('.bar, .edge, .mosaic, .btn, .spread-fab, .play-fab, .auto-cfg-fab, .q-group, input, textarea')) return;
          start = {
            x: e.clientX,
            y: e.clientY,
            sl: scr().scrollLeft,
            st: scr().scrollTop,
          };
          dragging = false;
          samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
          try {
            rd.classList.add('drag-scroll');
            rd.style.scrollBehavior = 'auto';
          } catch (_) {}
        };
        const applyScroll = () => {
          raf = 0;
          if (!start || !pending || !scrollWhileDrag) return;
          const { dx, dy } = pending;
          const axis = getAxis();
          if (axis === 'x') scr().scrollLeft = start.sl - dx;
          else scr().scrollTop = start.st - dy;
        };
        const onMove = (e) => {
          if (!start) return;
          if (!scrollWhileDrag) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (!dragging && Math.hypot(dx, dy) < 3) return;
          if (!dragging) {
            dragging = true;
            try { opts.onDragStart?.(); } catch (_) {}
          }
          try { e.preventDefault(); } catch (_) {}
          pending = { dx, dy };
          samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
          if (samples.length > 12) samples.shift();
          if (!raf) raf = requestAnimationFrame(applyScroll);
        };
        const onUp = (e) => {
          if (!start) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          const wasDrag = dragging;
          // Velocidad del puntero (px/ms) en los últimos ~120 ms: para el "lanzamiento" al soltar
          let vx = 0, vy = 0;
          try {
            const now = performance.now();
            const recent = samples.filter((p) => now - p.t <= 120);
            if (recent.length >= 2) {
              const a = recent[0], b = recent[recent.length - 1];
              const dt = Math.max(1, b.t - a.t);
              vx = (b.x - a.x) / dt;
              vy = (b.y - a.y) / dt;
            }
          } catch (_) {}
          samples = [];
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          if (scrollWhileDrag && pending) applyScroll();
          start = null;
          dragging = false;
          pending = null;
          try {
            rd.classList.remove('drag-scroll');
            rd.style.scrollBehavior = '';
          } catch (_) {}
          if (scrollWhileDrag) {
            try { opts.onDragEnd?.(wasDrag, { dx, dy, vx, vy }); } catch (_) {}
            // Si había overflow y el usuario arrastró, solo pan (no cambiar página)
            const axis0 = getAxis();
            const sc0 = scr();
            const hasOverflow = axis0 === 'y'
              ? (sc0.scrollHeight > sc0.clientHeight + 4)
              : (sc0.scrollWidth > sc0.clientWidth + 4);
            if (wasDrag && hasOverflow) return;
            // Sin overflow (modo pantalla) o tap: permitir swipe de página más abajo
          }
          const axis = getAxis();
          if (axis === 'x') {
            if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
            try { pokeUI(); } catch (_) {}
            if (dx < 0) goNext(); else goPrev();
          } else {
            // En modo ancho el eje es Y: swipe vertical en extremos cambia página
            if (Math.abs(dy) < 70 || Math.abs(dy) < Math.abs(dx) * 1.15) return;
            try { pokeUI(); } catch (_) {}
            if (dy < 0) goNext(); else goPrev();
          }
        };
        rd.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove, { passive: false });
        window.addEventListener('mouseup', onUp);
        // Evitar drag nativo de imágenes
        const onDragStart = (e) => { e.preventDefault(); };
        rd.addEventListener('dragstart', onDragStart);
        if (!rd._dragCleanups) rd._dragCleanups = [];
        rd._dragCleanups.push(() => {
          rd.removeEventListener('mousedown', onDown);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          rd.removeEventListener('dragstart', onDragStart);
          if (raf) cancelAnimationFrame(raf);
        });
      };


      let goToPage = (i) => {}; // se asigna en cada modo


      if (panelMode) {
        setRdClass('page panel-mode fit-screen');
        const pageHost = el('div', 'page-host panel-host');
        const sheet = el('div', 'panel-sheet');
        const img = el('img');
        img.draggable = false;
        sheet.append(img);
        const dimHole = el('div', 'panel-dim-hole');
        dimHole.setAttribute('aria-hidden', 'true');
        pageHost.append(sheet, dimHole);
        rd.append(pageHost, top, bot);

        const pagePanelsCache = new Map();
        let panels = [];
        let pIdx = 0;
        let fullView = true;

        const layoutImage = () => {
          const rect = pageHost.getBoundingClientRect();
          const pw = Math.max(1, Math.round(rect.width || pageHost.clientWidth || window.innerWidth));
          const ph = Math.max(1, Math.round(rect.height || pageHost.clientHeight || window.innerHeight));
          if (!img.naturalWidth) return { dispW: pw, dispH: ph, offX: 0, offY: 0, pw, ph };
          const ir = img.naturalWidth / Math.max(1, img.naturalHeight);
          const hr = pw / ph;
          let dispW, dispH;
          if (ir > hr) { dispW = pw; dispH = pw / ir; }
          else { dispH = ph; dispW = ph * ir; }
          const offX = (pw - dispW) / 2;
          const offY = (ph - dispH) / 2;
          img.style.cssText = `display:block;width:${dispW}px;height:${dispH}px;max-width:none;max-height:none;object-fit:fill;`;
          sheet.style.position = 'absolute';
          sheet.style.left = '0';
          sheet.style.top = '0';
          sheet.style.width = dispW + 'px';
          sheet.style.height = dispH + 'px';
          return { dispW, dispH, offX, offY, pw, ph };
        };

        const applyFocus = () => {
          const L = layoutImage();
          sheet.style.transformOrigin = '0 0';
          const hideDim = () => {
            pageHost.classList.remove('panel-focus');
            dimHole.style.cssText = 'display:none';
          };
          if (fullView || !panels.length) {
            sheet.style.transform = `translate3d(${L.offX}px,${L.offY}px,0)`;
            hideDim();
            return;
          }
          const panel = panels[Math.max(0, Math.min(panels.length - 1, pIdx))];
          if (!panel) {
            sheet.style.transform = `translate3d(${L.offX}px,${L.offY}px,0)`;
            hideDim();
            return;
          }
          pageHost.classList.add('panel-focus');
          const margin = 0.04;
          const px = Math.max(0, panel.x - margin);
          const py = Math.max(0, panel.y - margin);
          const pwN = Math.min(1 - px, panel.w + margin * 2);
          const phN = Math.min(1 - py, panel.h + margin * 2);
          // Deja un poco de margen para que se note el oscurecido alrededor
          const scale = (() => {
            const marginPct = Math.max(0, Math.min(25, +pref('panelMargin', '8') || 8));
            return Math.min(L.pw / Math.max(1, pwN * L.dispW), L.ph / Math.max(1, phN * L.dispH)) * (1 - marginPct / 100);
          })();
          const cx = (px + pwN / 2) * L.dispW;
          const cy = (py + phN / 2) * L.dispH;
          const tx = L.pw / 2 - cx * scale;
          const ty = L.ph / 2 - cy * scale;
          sheet.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${scale})`;
          // Agujero transparente + sombra enorme = oscurece el resto (no se recorta)
          const holeW = Math.max(8, pwN * L.dispW * scale);
          const holeH = Math.max(8, phN * L.dispH * scale);
          const holeL = (L.pw - holeW) / 2;
          const holeT = (L.ph - holeH) / 2;
          dimHole.style.cssText =
            'display:block;position:absolute;left:' + holeL + 'px;top:' + holeT +
            'px;width:' + holeW + 'px;height:' + holeH +
            'px;border-radius:4px;box-shadow:0 0 0 100vmax rgba(0,0,0,' + ((Math.max(0, Math.min(90, +pref('panelShadow', '55') || 55)) / 100).toFixed(2)) + ');' +
            'pointer-events:none;z-index:5;';
        };

        const loadPage = async (i, opts = {}) => {
          i = Math.max(0, Math.min(pages.length - 1, i));
          n = i;
          savePage(n);
          setCount();
          fullView = opts.fullView !== false;
          pIdx = 0;
          try {
            const u = await load(i);
            img.src = u;
            await img.decode().catch(() => {});
            if (pagePanelsCache.has(i)) {
              panels = pagePanelsCache.get(i) || [];
            } else {
              panels = await detectPanelsFromUrl(u);
              pagePanelsCache.set(i, panels);
            }
            if (opts.enterLast && panels.length) {
              fullView = false;
              pIdx = panels.length - 1;
            } else if (opts.enterFirst && panels.length) {
              fullView = false;
              pIdx = 0;
            }
            applyFocus();
            token++;
            const mine = token;
            preloadAround(i, token, mine);
          } catch (e) {
            console.warn('[panel]', e);
          }
        };

        const enterPanel = (idx) => {
          if (!panels.length) return;
          fullView = false;
          pIdx = Math.max(0, Math.min(panels.length - 1, idx));
          applyFocus();
        };

        const nextPanel = async () => {
          if (fullView) {
            if (panels.length) { enterPanel(0); return true; }
            if (n >= pages.length - 1) { showNextCard({ auto: false }); return false; }
            await loadPage(n + 1);
            return true;
          }
          if (pIdx < panels.length - 1) {
            pIdx++;
            applyFocus();
            return true;
          }
          if (n >= pages.length - 1) { showNextCard({ auto: false }); return false; }
          await loadPage(n + 1);
          return true;
        };

        const prevPanel = async () => {
          // Dentro de viñetas: retroceder índice
          if (!fullView && pIdx > 0) {
            pIdx--;
            applyFocus();
            return true;
          }
          // Primera viñeta → página anterior, última viñeta
          if (!fullView && pIdx === 0) {
            if (n <= 0) {
              fullView = true;
              applyFocus();
              return true;
            }
            await loadPage(n - 1, { fullView: false, enterLast: true });
            return true;
          }
          // Vista completa → página anterior (completa)
          if (n <= 0) return false;
          await loadPage(n - 1);
          return true;
        };

        goToPage = (i) => loadPage(i);

        // Play avanza viñetas
        autoStep = async () => {
          const more = await nextPanel();
          return more !== false;
        };

        // Navegación por laterales (pointer para táctil + ratón)
        let ptrStart = null;
        pageHost.addEventListener('pointerdown', (ev) => {
          if (ev.target.closest?.('.bar, .btn, .mosaic, .play-fab, .auto-cfg-fab, .q-group, .spread-fab, .rd-info-btn')) return;
          ptrStart = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, t: Date.now() };
        }, { passive: true });
        pageHost.addEventListener('pointerup', (ev) => {
          if (!ptrStart || ptrStart.id !== ev.pointerId) return;
          const dx = ev.clientX - ptrStart.x;
          const dy = ev.clientY - ptrStart.y;
          const dt = Date.now() - ptrStart.t;
          ptrStart = null;
          if (dt > 500 || Math.abs(dx) > 18 || Math.abs(dy) > 18) return; // no es tap
          const rect = pageHost.getBoundingClientRect();
          const x = ev.clientX - rect.left;
          const w = rect.width || 1;
          if (x < w * 0.30) {
            prevPanel();
            try { armUiHide(); } catch (_) {}
          } else if (x > w * 0.70) {
            nextPanel();
            try { armUiHide(); } catch (_) {}
          } else {
            // Centro: mostrar/ocultar menú (no maximizar)
            try { toggleUI(); } catch (_) {}
          }
        }, { passive: true });

        const onWheelPanel = (e) => {
          const dy = e.deltaY || 0;
          const dx = e.deltaX || 0;
          const dominant = Math.abs(dx) > Math.abs(dy) ? dx : dy;
          if (Math.abs(dominant) < 8) return;
          e.preventDefault();
          if (dominant > 0) nextPanel();
          else prevPanel();
          try { armUiHide(); } catch (_) {}
        };
        pageHost.addEventListener('wheel', onWheelPanel, { passive: false });
        observers._wheel = onWheelPanel;

        const onResizePanel = () => { try { applyFocus(); } catch (_) {} };
        addEventListener('resize', onResizePanel);
        observers._resize = onResizePanel;

        document.onkeydown = (ev) => {
          if (ev.key === 'ArrowRight' || ev.key === ' ') { ev.preventDefault(); nextPanel(); }
          else if (ev.key === 'ArrowLeft') { ev.preventDefault(); prevPanel(); }
          else if (ev.key === 'Escape') { fullView = true; applyFocus(); }
        };

        loadPage(n);
        try { pokeUI(); } catch (_) {}
        try { armUiHide(); } catch (_) {}
            } else if (!continuous) {
        setRdClass('page fit-' + pref('fit', 'screen') + (pref('spread', '0') === '1' ? ' spread' : ''));
        const fit = el('button', 'btn');
        const pageHost = el('div', 'page-host');
        // Página+Ancho: con flex centrado, una imagen más alta que la pantalla desborda por arriba
        // y esa parte no es alcanzable con scroll. Anclamos arriba y centramos solo en horizontal.
        const applyWidthAnchor = () => {
          const w = pref('fit', 'screen') === 'width';
          pageHost.style.alignItems = w ? 'flex-start' : '';
          pageHost.style.justifyContent = w ? 'flex-start' : '';
          pageHost.style.alignContent = w ? 'flex-start' : '';
          pageHost.style.overflowY = w ? 'auto' : '';
          for (const im of pageHost.querySelectorAll('img')) {
            im.style.margin = w ? '0 auto' : '';
            im.style.alignSelf = w ? 'flex-start' : '';
          }
          if (w) pageHost.scrollTop = 0;
        };
        let img = el('img');
        pageHost.append(img);
        const fitLabel = () => {
          const w = pref('fit', 'screen') === 'width';
          fit.replaceChildren();
          const ico = el('span', 'fit-ico', w ? '↔' : '⤢');
          const txt = el('span', 'fit-txt', w ? 'Ancho' : 'Pantalla');
          fit.append(ico, txt);
          fit.title = w ? 'Ajuste: Ancho' : 'Ajuste: Pantalla';
        };
        fit.onclick = () => {
          setPref('fit', pref('fit', 'screen') === 'screen' ? 'width' : 'screen');
          setRdClass(rd.className.replace(/fit-\w+/, 'fit-' + pref('fit', 'screen')));
          if (pref('spread', '0') === '1') rd.classList.add('spread');
          else rd.classList.remove('spread');
          try { applyWidthAnchor(); } catch (_) {}
          fitLabel();
          updateStatus();
          pokeUI();
        };
        fitLabel();
        const spreadBtn = el('button', 'btn spread-fab');
        const spreadLabel = () => {
          const on = pref('spread', '0') === '1';
          // on = doble página → icono de libro abierto; off = una página
          spreadBtn.innerHTML = on ? `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"/></svg>` : `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/></svg>`;
          spreadBtn.title = on ? 'Cambiar a una página' : 'Cambiar a doble página';
          spreadBtn.setAttribute('aria-label', spreadBtn.title);
        };
        spreadLabel();
        spreadBtn.onclick = (ev) => {
          try { ev.stopPropagation(); } catch (_) {}
          setPref('spread', pref('spread', '0') === '1' ? '0' : '1');
          spreadLabel();
          if (pref('spread', '0') === '1') rd.classList.add('spread');
          else rd.classList.remove('spread');
          updateStatus();
          pokeUI();
          turn(n);
        };
        // Fuera de la barra inferior: centrado encima del botbar
        rd.append(spreadBtn);
        botRight.append(fit, cnt);
        img.draggable = false;
        const eL = el('div', 'edge l'), eR = el('div', 'edge r');
        rd.append(pageHost, eL, eR, top, bot);
        const isSpread = () => pref('spread', '0') === '1';
        // Portada (0) siempre sola. Pares interiores: 1|2, 3|4… (n = página derecha guardada)
        const toSpreadRight = (i) => {
          i = Math.max(0, Math.min(pages.length - 1, i));
          if (i <= 0) return 0;
          // índice impar → derecha del par (1→2, 3→4)
          if (i % 2 === 1) return Math.min(pages.length - 1, i + 1);
          return i;
        };
        const spreadPair = (right) => {
          right = Math.max(0, Math.min(pages.length - 1, right));
          if (!isSpread() || right <= 0) return { left: null, right };
          // right debe ser par >= 2 para tener izquierda >= 1
          right = toSpreadRight(right);
          if (right <= 0) return { left: null, right: 0 };
          const left = right - 1;
          if (left <= 0) return { left: null, right: 0 };
          return { left, right };
        };
        const nextSpread = (right) => {
          if (right <= 0) return Math.min(pages.length - 1, pages.length > 1 ? 2 : 0);
          return Math.min(pages.length - 1, right + 2);
        };
        const prevSpread = (right) => {
          if (right <= 2) return 0;
          return right - 2;
        };
        const setCountSpread = () => {
          const { left, right } = spreadPair(n);
          if (left != null) cnt.textContent = (left + 1) + '–' + (right + 1) + ' / ' + pages.length;
          else setCount();
        };
        const turn = async (i) => {
          if (i > pages.length - 1) { if (hasNext) { if (nextCardOpen()) openNext(); else showNextCard(); } return; }
          closeNextCard();
          if (i < 0) return;
          let right = Math.max(0, Math.min(pages.length - 1, i));
          if (isSpread()) right = toSpreadRight(right);
          const { left } = spreadPair(right);
          n = right;
          savePage(n);
          if (isSpread() && left != null) setCountSpread();
          else setCount();
          try {
            if (typeof zoomLevel !== 'undefined') zoomLevel = 1;
            rd.classList.remove('zoom');
            rd.scrollTo(0, 0);
            pageHost.scrollTop = 0; pageHost.scrollLeft = 0;
          } catch (_) {}
          const mine = ++token;
          try {
            if (isSpread() && left != null) {
              const pair = await Promise.all([load(left), load(right)]);
              if (mine !== token) return;
              const imL = el('img'); imL.draggable = false; imL.className = 'spread-l'; imL.src = pair[0];
              const imR = el('img'); imR.draggable = false; imR.className = 'spread-r'; imR.src = pair[1];
              await Promise.all([imL.decode().catch(() => {}), imR.decode().catch(() => {})]);
              if (mine !== token) return;
              pageHost.replaceChildren(imL, imR);
              img = imR;
            } else {
              const u = await load(right);
              if (mine !== token) return;
              const im = el('img'); im.draggable = false; im.src = u;
              await im.decode().catch(() => {});
              if (mine !== token) return;
              pageHost.replaceChildren(im);
              img = im;
            }
            rd.scrollTo(0, 0);
            try {
              // Página+Ancho: imagen alta anclada arriba (no centrada → no se pierde el inicio)
              applyWidthAnchor();
              pageHost.scrollTop = 0;
              pageHost.scrollLeft = 0;
              requestAnimationFrame(() => {
                try { pageHost.scrollTop = 0; pageHost.scrollLeft = 0; } catch (_) {}
              });
            } catch (_) {}
            const keep = networkPreloadRadius() + 2;
            for (const i2 of [...urls.keys()]) if (i2 < n - keep || i2 > n + keep + 1) drop(i2);
            await preloadAround(n, token, mine);
            if (left != null) await preloadAround(left, token, mine);
          } catch (err) { cnt.textContent = 'Error'; console.error(err); }
        };
        goToPage = (i) => turn(isSpread() ? toSpreadRight(i) : i);
        // Play: página alta (ajuste Ancho) → primero se recorre hacia abajo; después, siguiente página/doble página
        autoStep = async () => {
          if (rd.classList.contains('zoom')) return true;
          const canY = pageHost.scrollHeight > pageHost.clientHeight + 6;
          if (canY && pageHost.scrollTop + pageHost.clientHeight < pageHost.scrollHeight - 8) {
            await animateScroll(pageHost, 'scrollTop', Math.min(pageHost.scrollTop + pageHost.clientHeight * 0.9, pageHost.scrollHeight - pageHost.clientHeight));
            return true;
          }
          const nxt = isSpread() ? nextSpread(n) : n + 1;
          if (nxt > pages.length - 1 || nxt === n) return false; // fin del cómic
          await turn(nxt);
          return true;
        };
        eL.onclick = () => turn(isSpread() ? prevSpread(n) : n - 1);
        eR.onclick = () => turn(isSpread() ? nextSpread(n) : n + 1);
        // En modo ancho permitir arrastrar para desplazar la página (eje Y);
        // en pantalla completa el drag horizontal cambia de página.
        bindMousePageDrag(
          () => (pref('fit', 'screen') === 'width' ? 'y' : 'x'),
          () => turn(isSpread() ? prevSpread(n) : n - 1),
          () => turn(isSpread() ? nextSpread(n) : n + 1),
          true,
          { scroller: () => pageHost }
        );


        /** Zoom variable: doble toque (~2.5×) y pellizco (1×–4×). Pan con un dedo. */
        let zoomLevel = 1;
        const ZOOM_DBL = 2.5;
        const ZOOM_MAX = 4;

        const clearZoom = () => {
          zoomLevel = 1;
          rd.classList.remove('zoom');
          const im = rd.querySelector('img');
          if (im) {
            im.style.removeProperty('width');
            im.style.removeProperty('max-width');
            im.style.removeProperty('max-height');
          }
          try { rd.scrollTo(0, 0); } catch (_) {}
        };

        /**
         * Cambia el nivel de zoom anclando el punto (clientX, clientY) del viewport
         * para que no “baile” la imagen (cálculo síncrono scroll/tamaño).
         */
        const setZoomLevel = (level, clientX, clientY) => {
          const im = rd.querySelector('img');
          if (!im) return;
          level = Math.max(1, Math.min(ZOOM_MAX, level));
          if (level <= 1.08) {
            clearZoom();
            return;
          }

          const rdRect = rd.getBoundingClientRect();
          const oldW = Math.max(1, im.offsetWidth || im.getBoundingClientRect().width);
          const oldH = Math.max(1, im.offsetHeight || im.getBoundingClientRect().height);

          let focusX = rd.clientWidth / 2;
          let focusY = rd.clientHeight / 2;
          if (clientX != null && clientY != null) {
            focusX = clientX - rdRect.left;
            focusY = clientY - rdRect.top;
          }

          // Punto del contenido bajo el foco (coords de scroll actuales)
          const contentX = rd.scrollLeft + focusX;
          const contentY = rd.scrollTop + focusY;
          const ratioX = contentX / oldW;
          const ratioY = contentY / oldH;

          zoomLevel = level;
          rd.classList.add('zoom');
          im.style.width = (zoomLevel * 100) + '%';
          im.style.maxWidth = 'none';
          im.style.maxHeight = 'none';

          // Layout síncrono → mismo ratio de contenido bajo el dedo
          const newW = Math.max(1, im.offsetWidth);
          const newH = Math.max(1, im.offsetHeight);
          rd.scrollLeft = Math.max(0, ratioX * newW - focusX);
          rd.scrollTop = Math.max(0, ratioY * newH - focusY);
        };

        const applyZoomAt = (clientX, clientY) => {
          if (rd.classList.contains('zoom') && zoomLevel > 1.08) {
            clearZoom();
            return;
          }
          setZoomLevel(ZOOM_DBL, clientX, clientY);
        };

        let lastTapT = 0, lastTapX = 0, lastTapY = 0, tapTimer = null, suppressClick = false;
        const DBL_MS = 420;
        const DBL_DIST = 56;

        const onTap = (clientX, clientY) => {
          const t = Date.now();
          const dt = t - lastTapT;
          const dist = Math.hypot(clientX - lastTapX, clientY - lastTapY);
          if (dt > 0 && dt < DBL_MS && dist < DBL_DIST) {
            clearTimeout(tapTimer);
            lastTapT = 0;
            applyZoomAt(clientX, clientY);
            return true;
          }
          lastTapT = t;
          lastTapX = clientX;
          lastTapY = clientY;
          clearTimeout(tapTimer);
          tapTimer = setTimeout(() => {
            if (!rd.classList.contains('zoom')) toggleUI();
          }, DBL_MS);
          return false;
        };

        const armSuppressClick = () => {
          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 500);
        };

        rd.onclick = (ev) => {
          if (suppressClick) return;
          if (ev.pointerType === 'touch') return;
          if (ev.target.closest?.('.bar, .edge, .mosaic')) return;
          if (ev.target.tagName !== 'IMG') return;
          onTap(ev.clientX, ev.clientY);
        };

        // Laterales: una sola acción (evitar doble turn por touch + click)
        const pageStep = () => (isSpread() ? 2 : 1);
        const edgeGo = (dir) => {
          if (suppressClick) return;
          armSuppressClick();
          clearZoom();
          if (isSpread()) turn(dir < 0 ? prevSpread(n) : nextSpread(n));
          else turn(dir < 0 ? n - 1 : n + 1);
        };
        eL.onclick = (ev) => { ev.stopPropagation(); edgeGo(-1); };
        eR.onclick = (ev) => { ev.stopPropagation(); edgeGo(1); };
        eL.addEventListener('touchend', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          armSuppressClick();
          clearZoom();
          if (isSpread()) turn(prevSpread(n)); else turn(n - 1);
        }, { passive: false });
        eR.addEventListener('touchend', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          armSuppressClick();
          clearZoom();
          if (isSpread()) turn(nextSpread(n)); else turn(n + 1);
        }, { passive: false });

        let sx = null, sy = 0, moved = false;
        let pinch = null; // { d0, z0 }

        const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const touchCenter = (a, b) => ({
          x: (a.clientX + b.clientX) / 2,
          y: (a.clientY + b.clientY) / 2,
        });

        rd.addEventListener('touchstart', (e) => {
          // Toque en laterales/barra: no iniciar gesto de página en #rd
          if (e.target.closest?.('.edge, .bar, .mosaic, .spread-fab, .play-fab, .auto-cfg-fab, .q-group')) {
            sx = null;
            pinch = null;
            return;
          }
          if (e.touches.length === 2) {
            sx = null;
            moved = false;
            pinch = {
              d0: Math.max(1, touchDist(e.touches[0], e.touches[1])),
              z0: Math.max(1, zoomLevel),
            };
            clearTimeout(tapTimer);
            lastTapT = 0;
            return;
          }
          pinch = null;
          if (e.touches.length !== 1) { sx = null; return; }
          const x = e.touches[0].clientX, y = e.touches[0].clientY;
          // iOS: no capturar borde izquierdo (gesto del sistema).
          // Android: sí (salida del lector); la franja .edge-back también captura.
          if (!isAndroid && x < 48) { sx = null; return; }
          sx = x; sy = y; moved = false;
        }, { passive: true });

        let pinchRaf = 0;
        let pinchPending = null;
        rd.addEventListener('touchmove', (e) => {
          if (pinch && e.touches.length === 2) {
            const d = Math.max(1, touchDist(e.touches[0], e.touches[1]));
            const c = touchCenter(e.touches[0], e.touches[1]);
            pinchPending = { level: pinch.z0 * (d / pinch.d0), x: c.x, y: c.y };
            if (!pinchRaf) {
              pinchRaf = requestAnimationFrame(() => {
                pinchRaf = 0;
                if (!pinchPending) return;
                const p = pinchPending;
                pinchPending = null;
                setZoomLevel(p.level, p.x, p.y);
              });
            }
            e.preventDefault();
            return;
          }
          if (sx == null || !e.touches[0]) return;
          if (Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 14) moved = true;
        }, { passive: false });

        rd.addEventListener('touchend', (e) => {
          if (e.target.closest?.('.edge, .bar, .mosaic, .spread-fab, .play-fab, .auto-cfg-fab, .q-group')) {
            sx = null;
            return;
          }
          if (e.touches.length >= 2) return;
          if (pinch) {
            pinch = null;
            armSuppressClick();
            if (zoomLevel <= 1.08) clearZoom();
            sx = null;
            return;
          }
          if (sx === null) return;
          if ((window.visualViewport?.scale || 1) > 1.05) { sx = null; return; }
          const x = e.changedTouches[0].clientX, y = e.changedTouches[0].clientY;
          const startX = sx;
          const dx = x - sx, dy = y - sy;
          sx = null;
          armSuppressClick();

          // Con zoom: solo pan o doble toque. Página = solo .edge (no zonas laterales aquí)
          if (rd.classList.contains('zoom')) {
            if (moved) return;
            onTap(x, y);
            return;
          }

          if (moved) {
            // Android: borde izquierdo → derecha = salir
            if (isAndroid && startX < 40 && dx > 50 && Math.abs(dy) < 100) {
              history.back();
              return;
            }
            if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) {
              turn(dx < 0 ? (isSpread() ? nextSpread(n) : n + 1) : (isSpread() ? prevSpread(n) : n - 1));
            }
            return;
          }

          if (e.target?.tagName === 'IMG' || e.target === rd || e.target?.closest?.('img')) {
            onTap(x, y);
          }
        }, { passive: true });

        document.onkeydown = (e) => { if (e.key === 'ArrowRight') turn(isSpread() ? nextSpread(n) : n + 1); if (e.key === 'ArrowLeft') turn(isSpread() ? prevSpread(n) : n - 1); };
        // Página + Ancho: rueda hace scroll en la hoja (.page-host); solo al llegar al borde cambia de página.
        // Página + Pantalla: sin cambios (siempre cabe → rueda cambia página).
        const onWheel = (e) => {
          if (rd.classList.contains('zoom')) return;
          const fitIsWidth = pref('fit', 'screen') === 'width';
          if (fitIsWidth) {
            const sc = pageHost;
            const overflow = sc.scrollHeight > sc.clientHeight + 2;
            if (overflow) {
              const dy = e.deltaMode === 1 ? e.deltaY * 16 : (e.deltaMode === 2 ? e.deltaY * sc.clientHeight : e.deltaY);
              const atTop = sc.scrollTop <= 1;
              const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
              if (dy > 0 && !atBottom) {
                // Sobre la hoja el navegador ya hace scroll; sobre los laterales (.edge) lo hacemos a mano
                if (!sc.contains(e.target)) { e.preventDefault(); sc.scrollTop += dy; }
                return;
              }
              if (dy < 0 && !atTop) {
                if (!sc.contains(e.target)) { e.preventDefault(); sc.scrollTop += dy; }
                return;
              }
              // En el borde: cambiar de página (con un gesto claro)
              e.preventDefault();
              if (dy > 10) turn(isSpread() ? nextSpread(n) : n + 1);
              else if (dy < -10) turn(isSpread() ? prevSpread(n) : n - 1);
              return;
            }
          }
          e.preventDefault();
          if (e.deltaY > 10) turn(isSpread() ? nextSpread(n) : n + 1);
          else if (e.deltaY < -10) turn(isSpread() ? prevSpread(n) : n - 1);
        };
        rd.addEventListener('wheel', onWheel, { passive: false });
        observers._wheel = onWheel;
        const onOrientPage = () => {
          resetMobileViewport();
          try { sizeReaderEl(rd); } catch (_) {}
          const w = Math.round(window.visualViewport?.width || window.innerWidth);
          const h = Math.round(window.visualViewport?.height || window.innerHeight);
          rd.style.width = w + 'px';
          rd.style.height = h + 'px';
          setRdClass('page fit-' + pref('fit', 'screen') + (pref('spread', '0') === '1' ? ' spread' : ''));
          if (img) {
            img.style.width = '';
            img.style.height = '';
            img.style.maxWidth = '';
            img.style.maxHeight = '';
            const s = img.src; img.src = ''; img.src = s;
          }
        };
        let rt = 0;
        const onOrientPageD = () => {
          clearTimeout(rt);
          rt = setTimeout(onOrientPage, 80);
          setTimeout(onOrientPage, 250);
          setTimeout(onOrientPage, 500);
        };
        addEventListener('resize', onOrientPageD);
        addEventListener('orientationchange', onOrientPageD);
        observers._resize = onOrientPageD;
        turn(n);
      } else {
        const GAP = 8; // hueco uniforme siempre
        const fitMode = () => (pref('fit', 'screen') === 'width' ? 'width' : 'screen');
        setRdClass((horiz ? 'horiz' : 'vert') + ' fit-' + fitMode());
        const fit = el('button', 'btn');
        const fitLabel = () => {
          const w = fitMode() === 'width';
          fit.replaceChildren();
          const ico = el('span', 'fit-ico', w ? '↔' : '⤢');
          const txt = el('span', 'fit-txt', w ? 'Ancho' : 'Pantalla');
          fit.append(ico, txt);
          fit.title = w ? 'Ajuste: Ancho' : 'Ajuste: Pantalla';
        };
        let onResize = null;
        fit.onclick = () => {
          setPref('fit', fitMode() === 'screen' ? 'width' : 'screen');
          setRdClass((horiz ? 'horiz' : 'vert') + ' fit-' + fitMode());
          fitLabel();
          updateStatus();
          pokeUI();
          onResize?.();
        };
        fitLabel();
        botRight.append(fit, cnt);

        const vw = () => Math.round(window.visualViewport?.width || window.innerWidth);
        const vh = () => Math.round(window.visualViewport?.height || window.innerHeight);
        // Estimación inicial estable (evita saltos)
        const estSize = () => {
          if (horiz) return fitMode() === 'width' ? vw() : Math.round(Math.min(vw(), vh() * 0.75));
          return fitMode() === 'width' ? Math.round(vw() * 1.4) : Math.min(vh(), Math.round(vw() * 1.4));
        };
        const sizes = new Array(pages.length).fill(estSize());
        const slots = pages.map((_, i) => {
          const d = el('div', 'slot');
          d.dataset.i = i;
          if (horiz) {
            d.style.flex = 'none';
            d.style.width = sizes[i] + 'px';
            d.style.minWidth = sizes[i] + 'px';
            d.style.height = '100%';
            d.style.marginRight = GAP + 'px';
            d.style.marginBottom = '0';
          } else {
            d.style.width = '100%';
            d.style.height = sizes[i] + 'px';
            d.style.minHeight = sizes[i] + 'px';
            d.style.marginBottom = GAP + 'px';
            d.style.marginRight = '0';
          }
          return d;
        });
        // Sin padding inicial (causaba doble hueco)
        const foot = el('div', 'next-comic');
        if (hasNext) {
          const nb = el('button', 'btn next-btn', 'Siguiente número →');
          nb.onclick = (ev) => { ev.stopPropagation(); showNextCard(); };
          foot.append(nb);
          {
            // Vertical y Horizontal: al llegar al final, mostrar la pantalla del siguiente (igual que en Página)
            let wasIn = false;
            const footIO = new IntersectionObserver((es) => {
              es.forEach((x) => {
                const inView = x.isIntersecting && x.intersectionRatio >= 0.6;
                if (inView && !wasIn) showNextCard();
                if (!x.isIntersecting && wasIn) closeNextCard();
                wasIn = inView || (wasIn && x.isIntersecting);
              });
            }, { root: rd, threshold: [0, 0.6] });
            setTimeout(() => { try { footIO.observe(foot); } catch (_) {} }, 600);
            footObs = footIO;
          }
        } else {
          foot.append(el('div', 'next-end', 'Fin'));
        }
        rd.append(...slots, foot, top, bot);

        const loaded = new Map();
        let syncLock = true;
        let scrollT = 0;

        const posOf = (i) => {
          let y = 0;
          for (let k = 0; k < i; k++) y += sizes[k] + GAP;
          return y;
        };
        const pageAt = (mid) => {
          let y = 0;
          for (let k = 0; k < pages.length; k++) {
            const h = sizes[k] + GAP;
            if (y + h > mid) return k;
            y += h;
          }
          return pages.length - 1;
        };

        /** Aplica estilos de imagen según eje + ajuste */
        /** Escala la imagen para caber en el viewport (también agranda si es pequeña). */
        const fitContainSize = (nw, nh, maxW, maxH) => {
          const w0 = Math.max(1, nw || 1);
          const h0 = Math.max(1, nh || 1);
          const scale = Math.min(maxW / w0, maxH / h0);
          return {
            w: Math.max(1, Math.round(w0 * scale)),
            h: Math.max(1, Math.round(h0 * scale)),
          };
        };

        const applyImg = (im, slot) => {
          const screen = fitMode() === 'screen';
          im.style.display = 'block';
          im.style.margin = '0 auto';
          im.style.objectFit = 'contain';
          im.style.objectPosition = 'center';
          // Limpiar tamaños previos (evita "zoom" al rotar)
          im.style.width = '';
          im.style.height = '';
          im.style.maxWidth = '';
          im.style.maxHeight = '';
          if (horiz) {
            if (screen) {
              const { w, h } = fitContainSize(im.naturalWidth, im.naturalHeight, vw(), vh());
              im.style.width = w + 'px';
              im.style.height = h + 'px';
              im.style.maxWidth = 'none';
              im.style.maxHeight = 'none';
              im.style.flexShrink = '0';
              slot.dataset.fitW = String(w);
              slot.dataset.fitH = String(h);
              slot.style.overflow = 'hidden';
              slot.style.display = 'flex';
              slot.style.alignItems = 'center';
              slot.style.justifyContent = 'center';
            } else {
              // Ancho = 100% del viewport
              im.style.width = '100%';
              im.style.maxWidth = '100%';
              im.style.height = 'auto';
              im.style.maxHeight = 'none';
              im.style.flex = 'none';
              im.style.flexShrink = '0';
              slot.style.overflowX = 'hidden';
              slot.style.overflowY = 'auto';
              slot.style.webkitOverflowScrolling = 'touch';
              delete slot.dataset.fitW;
              delete slot.dataset.fitH;
            }
            slot.style.height = '100%';
            slot.style.maxHeight = '100%';

          } else {
            if (screen) {
              const { w, h } = fitContainSize(im.naturalWidth, im.naturalHeight, vw(), vh());
              im.style.width = w + 'px';
              im.style.height = h + 'px';
              im.style.maxWidth = 'none';
              im.style.maxHeight = 'none';
              slot.dataset.fitW = String(w);
              slot.dataset.fitH = String(h);
            } else {
              im.style.width = '100%';
              im.style.maxWidth = '100%';
              im.style.height = 'auto';
              im.style.maxHeight = 'none';
              delete slot.dataset.fitW;
              delete slot.dataset.fitH;
            }
            slot.style.overflow = 'hidden';
            slot.style.width = '100%';
            slot.style.display = 'flex';
            slot.style.justifyContent = 'center';
            slot.style.alignItems = 'flex-start';
          }
        };

        const measure = (im, slot) => {
          if (horiz) {
            if (fitMode() === 'width') return Math.max(1, vw());
            // Pantalla: ancho real de la imagen escalada (hueco uniforme = solo GAP)
            const fw = +slot.dataset.fitW || 0;
            if (fw > 0) return fw;
            return Math.max(1, Math.round(im.getBoundingClientRect().width) || im.offsetWidth || sizes[0]);
          }
          const fh = +slot.dataset.fitH || 0;
          if (fitMode() === 'screen' && fh > 0) return fh;
          return Math.max(1, Math.round(im.getBoundingClientRect().height) || im.offsetHeight || sizes[0]);
        };

        const place = (i, im) => {
          const slot = slots[i];
          const prev = sizes[i];
          slot.replaceChildren(im);
          applyImg(im, slot);
          const h = measure(im, slot);
          sizes[i] = h;
          if (horiz) {
            slot.style.width = h + 'px';
            slot.style.minWidth = h + 'px';
            slot.style.marginRight = GAP + 'px';
            if (fitMode() === 'width') {
              const imgH = im.offsetHeight || im.naturalHeight || 0;
              const viewH = (window.visualViewport?.height || vh());
              const tall = imgH > viewH + 4;
              slot.dataset.tall = tall ? '1' : '0';
              if (tall) {
                slot.style.display = 'block';
                slot.style.overflowY = 'auto';
                slot.style.alignItems = '';
                slot.style.justifyContent = '';
              } else {
                slot.style.display = 'flex';
                slot.style.alignItems = 'center';
                slot.style.justifyContent = 'center';
                slot.style.overflowY = 'hidden';
                slot.scrollTop = 0;
              }
            } else {
              slot.style.display = 'flex';
              slot.style.alignItems = 'center';
              slot.style.justifyContent = 'center';
              slot.style.overflowY = 'hidden';
              slot.dataset.tall = '0';
            }
          } else {
            slot.style.height = h + 'px';
            slot.style.minHeight = h + 'px';
            slot.style.marginBottom = GAP + 'px';
          }
          const delta = h - prev;
          if (!syncLock && delta) {
            if (horiz && posOf(i) + Math.min(prev, h) <= rd.scrollLeft + 2) rd.scrollLeft += delta;
            if (!horiz && posOf(i) + Math.min(prev, h) <= rd.scrollTop + 2) rd.scrollTop += delta;
          }
        };

        const ensure = async (i) => {
          if (i < 0 || i >= pages.length || loaded.has(i)) return;
          loaded.set(i, true);
          try {
            const im = el('img');
            im.decoding = 'async';
            im.draggable = false;
            im.src = await load(i);
            await im.decode().catch(() => {});
            if (!slots[i].isConnected) return;
            place(i, im);
          } catch {
            loaded.delete(i);
          }
        };

        const jumpTo = (i) => {
          i = Math.max(0, Math.min(pages.length - 1, i));
          const p = posOf(i);
          if (horiz) rd.scrollLeft = p;
          else rd.scrollTop = p;
        };

        goToPage = async (i) => {
          i = Math.max(0, Math.min(pages.length - 1, i));
          n = i;
          savePage(n);
          setCount();
          syncLock = true;
          jumpTo(i);
          await ensure(i);
          jumpTo(i);
          ensure(i - 1); ensure(i + 1); ensure(i + 2);
          requestAnimationFrame(() => {
            jumpTo(i);
            setTimeout(() => { syncLock = false; }, 150);
          });
        };
        // Horizontal con ratón: al soltar encaja la página con animación suave (se asigna más abajo)
        let horizSnap = null;
        bindMousePageDrag(
          () => (horiz ? 'x' : 'y'),
          () => { goToPage(n - 1); },
          () => { goToPage(n + 1); },
          true,
          {
            onDragStart: () => {
              syncLock = true;
              clearTimeout(scrollT);
              autoCancelAnim();
              try {
                rd.classList.add('drag-scroll');
                rd.style.scrollSnapType = 'none';
                rd.style.scrollBehavior = 'auto';
              } catch (_) {}
            },
            onDragEnd: (wasDrag, info) => {
              const release = () => requestAnimationFrame(() => {
                syncLock = false;
                try { onScroll(); } catch (_) {}
              });
              if (horiz && wasDrag && horizSnap) {
                Promise.resolve(horizSnap(info)).then(release, release);
              } else {
                // Liberar y sincronizar página visible
                release();
              }
            },
          }
        );

        // Play: Vertical/Horizontal. Páginas altas (ajuste Ancho) se recorren por tramos; después, siguiente página con scroll suave
        autoStep = async () => {
          if (syncLock) return true;
          if (horiz) {
            const idx = pageAt(rd.scrollLeft + rd.clientWidth * 0.35);
            const slot = slots[idx];
            if (fitMode() === 'width' && slot && slot.dataset.tall === '1'
              && slot.scrollHeight > slot.clientHeight + 6
              && slot.scrollTop + slot.clientHeight < slot.scrollHeight - 8) {
              await animateScroll(slot, 'scrollTop', Math.min(slot.scrollTop + slot.clientHeight * 0.9, slot.scrollHeight - slot.clientHeight));
              return true;
            }
            if (idx >= pages.length - 1) return false;
            await ensure(idx + 1);
            ensure(idx + 2);
            await animateScroll(rd, 'scrollLeft', posOf(idx + 1));
            return true;
          }
          const top = rd.scrollTop;
          const vhh = rd.clientHeight;
          const idx = pageAt(top + vhh * 0.35);
          const pBot = posOf(idx) + sizes[idx];
          if (pBot - (top + vhh) > 12) {
            await animateScroll(rd, 'scrollTop', Math.min(top + vhh * 0.9, pBot - vhh));
            return true;
          }
          if (idx >= pages.length - 1) return false;
          await ensure(idx + 1);
          ensure(idx + 2);
          await animateScroll(rd, 'scrollTop', posOf(idx + 1));
          return true;
        };

        const onScroll = () => {
          if (syncLock) return;
          clearTimeout(scrollT);
          scrollT = setTimeout(() => {
            const mid = horiz
              ? rd.scrollLeft + rd.clientWidth * 0.35
              : rd.scrollTop + rd.clientHeight * 0.35;
            const idx = pageAt(mid);
            if (idx !== n) {
              n = idx;
              savePage(n);
              setCount();
            }
            for (let k = n - 2; k <= n + 4; k++) ensure(k);
            for (const i of [...loaded.keys()]) {
              if (Math.abs(i - n) <= 10) continue;
              const s = slots[i];
              if (horiz) {
                s.style.width = sizes[i] + 'px';
                s.style.minWidth = sizes[i] + 'px';
              } else {
                s.style.height = sizes[i] + 'px';
                s.style.minHeight = sizes[i] + 'px';
              }
              s.replaceChildren();
              loaded.delete(i);
              drop(i);
            }
          }, 80);
        };
        rd.addEventListener('scroll', onScroll, { passive: true });

        const loadIO = new IntersectionObserver((es) => {
          es.forEach((x) => { if (x.isIntersecting) ensure(+x.target.dataset.i); });
        }, { root: rd, rootMargin: horiz ? '0px 80%' : '80% 0px' });
        slots.forEach((s) => loadIO.observe(s));
        observers = [loadIO];
        if (footObs) observers.push(footObs);
        observers._scroll = onScroll;

        rd.onclick = (ev) => {
          if (ev.target.closest?.('.bar, .next-btn, .mosaic')) return;
          toggleUI();
        };

        onResize = () => {
          // Bloquear scroll handler: si no, al cambiar anchos el mid-scroll
          // interpreta otra página (salta 3/9/12 al girar el móvil).
          syncLock = true;
          clearTimeout(scrollT);
          const stay = Math.max(0, Math.min(pages.length - 1, n));

          resetMobileViewport();
          try { sizeReaderEl(rd); } catch (_) {}
          const w = vw(), h = vh();
          rd.style.width = w + 'px';
          rd.style.height = h + 'px';

          for (let i = 0; i < pages.length; i++) {
            const im = slots[i].querySelector('img');
            if (im) {
              im.style.width = '';
              im.style.height = '';
              place(i, im); // syncLock ⇒ place no mueve el scroll
            } else {
              const e = estSize();
              sizes[i] = e;
              if (horiz) {
                slots[i].style.width = e + 'px';
                slots[i].style.minWidth = e + 'px';
                slots[i].style.marginRight = GAP + 'px';
              } else {
                slots[i].style.height = e + 'px';
                slots[i].style.minHeight = e + 'px';
                slots[i].style.marginBottom = GAP + 'px';
              }
            }
          }

          // Restaurar la MISMA página (scroll instantáneo, no smooth)
          const snapStay = () => {
            n = stay;
            if (horiz) rd.scrollLeft = posOf(stay);
            else rd.scrollTop = posOf(stay);
            setCount();
          };
          snapStay();
          requestAnimationFrame(() => {
            snapStay();
            requestAnimationFrame(() => {
              snapStay();
              // Liberar tras asentar layout
              setTimeout(() => {
                snapStay();
                syncLock = false;
              }, 120);
            });
          });
        };
        let resizeT = 0;
        let resizeT2 = 0;
        const onOrient = () => {
          // Congelar índice de página enseguida
          syncLock = true;
          clearTimeout(scrollT);
          clearTimeout(resizeT);
          clearTimeout(resizeT2);
          // Una pasada al estabilizar viewport + una de refuerzo (iOS)
          resizeT = setTimeout(onResize, 100);
          resizeT2 = setTimeout(onResize, 350);
        };
        addEventListener('resize', onOrient);
        addEventListener('orientationchange', onOrient);
        if (window.visualViewport) {
          visualViewport.addEventListener('resize', onOrient);
          observers._vv = onOrient;
        }
        observers._resize = onOrient;

        // Horizontal + Ancho + página alta: bloqueo de eje con arrastre suave
        // - Vertical: scroll interno de la página
        // - Horizontal: mueve el strip con el dedo y al soltar encaja la página
        if (horiz) {
          let axis = null, sx = 0, sy = 0, baseLeft = 0, baseTop = 0, activeSlot = null;
          let lastX = 0, lastT = 0, velX = 0;
          const snapTo = (idx) => {
            idx = Math.max(0, Math.min(pages.length - 1, idx));
            const target = posOf(idx);
            try {
              rd.scrollTo({ left: target, behavior: 'smooth' });
            } catch (_) {
              rd.scrollLeft = target;
            }
            if (idx !== n) {
              n = idx;
              savePage(n);
              setCount();
              // No forzar scrollTop=0: respeta dónde estaba / inicio natural
              ensure(idx - 1); ensure(idx); ensure(idx + 1); ensure(idx + 2);
            }
          };
          horizSnap = (info = {}) => {
            const w = Math.max(1, sizes[n] || rd.clientWidth);
            const offset = rd.scrollLeft - posOf(n);
            const vx = info.vx || 0;
            let idx = n;
            // Cambio de página: ~35 % o lanzamiento claro; si no, vuelve con animación suave
            if (offset > w * 0.35 || vx < -0.7) idx = Math.min(pages.length - 1, n + 1);
            else if (offset < -w * 0.35 || vx > 0.7) idx = Math.max(0, n - 1);
            else {
              // página bajo el centro si el arrastre cruzó bastante
              const far = pageAt(rd.scrollLeft + rd.clientWidth / 2);
              if (far !== n && Math.abs(offset) > w * 0.2) idx = far;
            }
            if (idx !== n) {
              n = idx;
              savePage(n);
              setCount();
              ensure(idx - 1); ensure(idx); ensure(idx + 1); ensure(idx + 2);
            }
            // Siempre animar al destino (también al volver a la misma página) → sensación fluida
            const dist = Math.abs(rd.scrollLeft - posOf(idx));
            const dur = Math.min(380, Math.max(180, dist * 0.45));
            return animateScroll(rd, 'scrollLeft', posOf(idx), dur);
          };
          const onTs = (e) => {
            if (e.touches.length !== 1) { axis = null; return; }
            axis = null;
            velX = 0;
            sx = lastX = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            lastT = performance.now();
            baseLeft = rd.scrollLeft;
            activeSlot = slots[n];
            baseTop = activeSlot ? activeSlot.scrollTop : 0;
          };
          const onTm = (e) => {
            if (fitMode() !== 'width' || !activeSlot || activeSlot.dataset.tall !== '1') return;
            if (e.touches.length !== 1) return;
            const x = e.touches[0].clientX, y = e.touches[0].clientY;
            const dx = x - sx, dy = y - sy;
            if (!axis) {
              if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
              axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
            }
            if (axis === 'x') {
              e.preventDefault();
              // 1:1 con el dedo
              rd.scrollLeft = baseLeft - dx;
              const now = performance.now();
              const dt = Math.max(1, now - lastT);
              velX = (x - lastX) / dt;
              lastX = x;
              lastT = now;
            } else if (axis === 'y') {
              e.preventDefault();
              // 1:1 vertical (sin saltar al top)
              activeSlot.scrollTop = Math.max(0, baseTop - dy);
            }
          };
          const onTe = () => {
            if (axis === 'x') {
              const w = Math.max(1, sizes[n] || rd.clientWidth);
              const offset = rd.scrollLeft - posOf(n);
              let idx = n;
              // Poco recorrido basta (~15%) o un flick ligero
              if (offset > w * 0.15 || velX < -0.25) idx = Math.min(pages.length - 1, n + 1);
              else if (offset < -w * 0.15 || velX > 0.25) idx = Math.max(0, n - 1);
              snapTo(idx);
            }
            axis = null;
            activeSlot = null;
            velX = 0;
          };
          rd.addEventListener('touchstart', onTs, { passive: true });
          rd.addEventListener('touchmove', onTm, { passive: false });
          rd.addEventListener('touchend', onTe, { passive: true });
          rd.addEventListener('touchcancel', onTe, { passive: true });
          observers._touchStart = onTs;
          observers._touchMove = onTm;
          observers._touchEnd = onTe;

          // PC: rueda cambia de página en horizontal; en páginas altas (ajuste ancho) primero recorre vertical
          const onWheelH = (e) => {
            const dy = e.deltaY || 0;
            const dx = e.deltaX || 0;
            const dominant = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(dominant) < 8) return;
            // Página alta en ajuste ancho: dejar scroll vertical interno hasta el borde
            if (fitMode() === 'width') {
              const slot = slots[n];
              if (slot && slot.dataset.tall === '1') {
                const canY = slot.scrollHeight > slot.clientHeight + 2;
                if (canY) {
                  const atTop = slot.scrollTop <= 0;
                  const atBot = slot.scrollTop + slot.clientHeight >= slot.scrollHeight - 2;
                  if ((dominant < 0 && !atTop) || (dominant > 0 && !atBot)) return;
                }
              }
            }
            e.preventDefault();
            snapTo(dominant > 0 ? n + 1 : n - 1);
          };
          rd.addEventListener('wheel', onWheelH, { passive: false });
          observers._wheel = onWheelH;

          // Laterales: click izq/der en modo horizontal continuo
          const onHorizEdgeClick = (ev) => {
            if (ev.target.closest?.('.bar, .edge, .mosaic, .btn, .play-fab, .auto-cfg-fab, .q-group, .spread-fab')) return;
            if (rd.classList.contains('zoom')) return;
            const rect = rd.getBoundingClientRect();
            const x = ev.clientX - rect.left;
            const w = rect.width || 1;
            if (x < w * 0.22) {
              ev.preventDefault();
              snapTo(Math.max(0, n - 1));
            } else if (x > w * 0.78) {
              ev.preventDefault();
              snapTo(Math.min(pages.length - 1, n + 1));
            }
          };
          rd.addEventListener('click', onHorizEdgeClick);
          observers._horizEdgeClick = onHorizEdgeClick;
        }

        goToPage(n);
      }
      setCount();
      return () => {
        closeNextCard();
        clearTimeout(uiTimer);
        clearTimeout(autoT);
        try { autoCancelAnim(); } catch (_) {}
        observers.forEach((o) => { try { o.disconnect(); } catch (_) {} });
        if (observers._scroll) rd.removeEventListener('scroll', observers._scroll);
        if (observers._wheel) rd.removeEventListener('wheel', observers._wheel);
        if (observers._touchStart) rd.removeEventListener('touchstart', observers._touchStart);
        if (observers._touchMove) rd.removeEventListener('touchmove', observers._touchMove);
        if (observers._touchEnd) {
          rd.removeEventListener('touchend', observers._touchEnd);
          rd.removeEventListener('touchcancel', observers._touchEnd);
        }
        if (observers._resize) {
          removeEventListener('resize', observers._resize);
          removeEventListener('orientationchange', observers._resize);
        }
        if (observers._vv && window.visualViewport) {
          visualViewport.removeEventListener('resize', observers._vv);
        }
        // limpiar estilos forzados del contenedor
        try { rd.style.width = ''; rd.style.height = ''; } catch (_) {}
        for (const i of [...urls.keys()]) drop(i);
        document.onkeydown = null;
        document.querySelector('.mosaic')?.remove();
        rd.remove();
        // Si se remonta el modo al instante, enterReaderFullscreen vuelve a poner la clase.
        try {
          if (!document.getElementById('rd')) exitReaderFullscreen();
          else enterReaderFullscreen();
        } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('tgcomic:reader', { detail: { open: false } })); } catch (_) {}
      };
    };
    let unmount = mount();
    return () => {
      closeNextCard();
      try { unmount(); } catch (_) {}
      try { dropAll(); } catch (_) {}
      try { Promise.resolve(zr.close()).catch(() => {}); } catch (_) {}
    };
  }


  return { openComic, resolveQueue, reader };
}
