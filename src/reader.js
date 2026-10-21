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
  } = d;

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

  async function resolveQueue(ch, f) {
    try {
      let files = (await kv.get('f:' + ch.id)) || [];
      if (!files.length) files = await fetchFiles(ch);
      for (const { files: fs } of groupSeries(files, ch.name, seriesOverrideFor(ch))) {
        if (fs.some((x) => x.id === f.id)) return fs.length > 1 ? fs : files;
      }
      return files;
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
        setLastRead(ch, f);
        const status = (t) => { if (!cancelled(ac) && alive(e)) msg(t); };
        const list = queue && queue.length ? queue : await resolveQueue(ch, f);
        const idx = Math.max(0, list.findIndex((x) => x.id === f.id));
        // Preferir entrada fresca del listado (tamaño puede haber cambiado al resubir en Telegram)
        try {
          const fresh = list.find((x) => String(x.id) === String(f.id));
          if (fresh?.size) f = { ...f, size: fresh.size, name: fresh.name || f.name, caption: fresh.caption ?? f.caption };
        } catch (_) {}
        const openArc = async () => {
          const m0 = await getMsg(ch, f, { force: true });
          let size = Number(f.size) || 0;
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
          try { await pageCache?.clearComic?.(ch.id, f.id); } catch (_) {}
          try {
            const files = await fetchFiles(ch);
            const fresh2 = files.find((x) => String(x.id) === String(f.id));
            if (fresh2) f = { ...f, size: fresh2.size, name: fresh2.name || f.name, caption: fresh2.caption ?? f.caption };
          } catch (_) {}
          status('Reintentando apertura…');
          arc = await openArc();
        }
        if (cancelled(ac) || !alive(e)) { try { arc.close(); } catch (_) {} return; }
        if (!arc.pages.length) return msg('No se encontraron imágenes.');
        pageBlob(arc.pages[0]).then((b) => saveCoverBlob(ch, f, b)).catch(() => {});
        rdClean = reader(f, arc.pages, arc, { ch, list, idx });
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

  function reader(f, pages, zr, ctx) {
    const chId = ctx?.ch?.id;
    const savePage = (i) => { if (chId != null) { setPageIndex(chId, f.id, i); try { setLastRead(ch, f); } catch (_) {} } };
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
          const hit = await pageCache.get(chId, f.id, i);
          if (hit) return hit;
        } catch (_) {}
      }
      const b = await pageBlob(pages[i]);
      if (b && pageCache && chId != null) {
        pageCache.set(chId, f.id, i, b).catch(() => {});
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
      openComic(ctx.ch, ctx.list[ctx.idx + 1], ctx.list, { replace: true });
    };

    const mount = () => {
      n = Math.min(chId != null ? getPageIndex(chId, f.id) : (n || 0), pages.length - 1);
      let mode = pref('mode', 'page');
      if (mode !== 'page' && mode !== 'vertical' && mode !== 'horizontal') mode = 'page';
      const vert = mode === 'vertical';
      const horiz = mode === 'horizontal';
      const continuous = vert || horiz;
      let token = 0, observers = [];
      const rd = el('div'); rd.id = 'rd';
      try { window.dispatchEvent(new CustomEvent('tgcomic:reader', { detail: { open: true } })); } catch (_) {}
      // Barra superior: título + estado de modo
      const top = el('div', 'bar topbar');
      const modeName = { page: 'Página', vertical: 'Vertical', horizontal: 'Horizontal' };
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
          if (dx > 48 && Math.abs(dy) < 110) history.back();
        }, { passive: true });
        rd.append(edgeBack);
      }
      const uiHideMs = () => {
        const sec = Math.max(3, Math.min(120, +(pref('uiHideSec', '15') || 15)));
        return sec * 1000;
      };
      let uiTimer = setTimeout(() => rd.classList.add('ui-off'), uiHideMs());
      const pokeUI = () => {
        rd.classList.remove('ui-off');
        clearTimeout(uiTimer);
        uiTimer = setTimeout(() => rd.classList.add('ui-off'), uiHideMs());
      };
      cluster.addEventListener('mouseenter', () => {
        rd.classList.remove('ui-off');
        clearTimeout(uiTimer);
      });
      cluster.addEventListener('mouseleave', () => { pokeUI(); });
      bot.addEventListener('mouseenter', () => {
        rd.classList.remove('ui-off');
        clearTimeout(uiTimer);
      });
      bot.addEventListener('mouseleave', () => { pokeUI(); });

      const showMosaic = (ev) => {
        try { ev?.preventDefault?.(); ev?.stopPropagation?.(); } catch (_) {}
        pokeUI();
        document.querySelectorAll('.mosaic').forEach((x) => x.remove());
        const overlay = el('div', 'mosaic');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:200;';
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
            try { e.stopPropagation(); } catch (_) {}
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
      const bindMousePageDrag = (getAxis, goPrev, goNext, scrollWhileDrag) => {
        let start = null;
        let dragging = false;
        const onDown = (e) => {
          if (e.button !== 0) return;
          if (e.target.closest?.('.bar, .edge, .mosaic, .btn, .spread-fab, input, textarea')) return;
          start = {
            x: e.clientX,
            y: e.clientY,
            sl: rd.scrollLeft,
            st: rd.scrollTop,
          };
          dragging = false;
        };
        const onMove = (e) => {
          if (!start || !scrollWhileDrag) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (!dragging && Math.hypot(dx, dy) < 4) return;
          dragging = true;
          try { e.preventDefault(); } catch (_) {}
          const axis = getAxis();
          if (axis === 'x') rd.scrollLeft = start.sl - dx;
          else rd.scrollTop = start.st - dy;
          try { pokeUI(); } catch (_) {}
        };
        const onUp = (e) => {
          if (!start) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          const wasDrag = dragging;
          start = null;
          dragging = false;
          if (scrollWhileDrag) {
            // El scroll ya se hizo en mousemove; no saltar de página
            return;
          }
          const axis = getAxis();
          if (axis === 'x') {
            if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
            try { pokeUI(); } catch (_) {}
            if (dx < 0) goNext(); else goPrev();
          } else {
            if (Math.abs(dy) < 70 || Math.abs(dy) < Math.abs(dx) * 1.15) return;
            try { pokeUI(); } catch (_) {}
            if (dy < 0) goNext(); else goPrev();
          }
        };
        rd.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        if (!rd._dragCleanups) rd._dragCleanups = [];
        rd._dragCleanups.push(() => {
          rd.removeEventListener('mousedown', onDown);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        });
      };


      let goToPage = (i) => {}; // se asigna en cada modo

      if (!continuous) {
        rd.className = 'page fit-' + pref('fit', 'screen') + (pref('spread', '0') === '1' ? ' spread' : '');
        const fit = el('button', 'btn');
        const pageHost = el('div', 'page-host');
        let img = el('img');
        pageHost.append(img);
        const fitLabel = () => (fit.textContent = pref('fit', 'screen') === 'screen' ? '↔ Ancho' : '⤢ Pantalla');
        fit.onclick = () => {
          setPref('fit', pref('fit', 'screen') === 'screen' ? 'width' : 'screen');
          rd.className = rd.className.replace(/fit-\w+/, 'fit-' + pref('fit', 'screen'));
          if (pref('spread', '0') === '1') rd.classList.add('spread');
          else rd.classList.remove('spread');
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
          if (i > pages.length - 1) { if (hasNext) openNext(); return; }
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
            const keep = networkPreloadRadius() + 2;
            for (const i2 of [...urls.keys()]) if (i2 < n - keep || i2 > n + keep + 1) drop(i2);
            await preloadAround(n, token, mine);
            if (left != null) await preloadAround(left, token, mine);
          } catch (err) { cnt.textContent = 'Error'; console.error(err); }
        };
        goToPage = (i) => turn(isSpread() ? toSpreadRight(i) : i);
        eL.onclick = () => turn(isSpread() ? prevSpread(n) : n - 1);
        eR.onclick = () => turn(isSpread() ? nextSpread(n) : n + 1);
        bindMousePageDrag(() => 'x',
          () => turn(isSpread() ? prevSpread(n) : n - 1),
          () => turn(isSpread() ? nextSpread(n) : n + 1)
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

        let lastTapT = 0, lastTapX = 0, lastTapY = 0, uiTimer = null, suppressClick = false;
        const DBL_MS = 420;
        const DBL_DIST = 56;

        const onTap = (clientX, clientY) => {
          const t = Date.now();
          const dt = t - lastTapT;
          const dist = Math.hypot(clientX - lastTapX, clientY - lastTapY);
          if (dt > 0 && dt < DBL_MS && dist < DBL_DIST) {
            clearTimeout(uiTimer);
            lastTapT = 0;
            applyZoomAt(clientX, clientY);
            return true;
          }
          lastTapT = t;
          lastTapX = clientX;
          lastTapY = clientY;
          clearTimeout(uiTimer);
          uiTimer = setTimeout(() => {
            if (!rd.classList.contains('zoom')) rd.classList.toggle('ui-off');
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
          if (e.target.closest?.('.edge, .bar, .mosaic')) {
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
            clearTimeout(uiTimer);
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
          if (e.target.closest?.('.edge, .bar, .mosaic')) {
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
            if (dy > 90 && dy > 1.6 * Math.abs(dx)) {
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
        // Página + Ancho: rueda hace scroll en la hoja; solo al borde cambia de página.
        // Página + Pantalla: sin cambios (siempre cabe → rueda cambia página).
        const onWheel = (e) => {
          const fitIsWidth = pref('fit', 'screen') === 'width';
          if (fitIsWidth) {
            // Asegurar que #rd pueda hacer scroll con la rueda
            if (getComputedStyle(rd).overflowY === 'hidden') rd.style.overflowY = 'auto';
            const overflow = rd.scrollHeight > rd.clientHeight + 2;
            if (overflow) {
              const atTop = rd.scrollTop <= 1;
              const atBottom = rd.scrollTop + rd.clientHeight >= rd.scrollHeight - 2;
              if (e.deltaY > 10) {
                if (!atBottom) {
                  // No preventDefault → el navegador hace scroll en la hoja
                  return;
                }
                e.preventDefault();
                turn(isSpread() ? nextSpread(n) : n + 1);
                return;
              }
              if (e.deltaY < -10) {
                if (!atTop) return;
                e.preventDefault();
                turn(isSpread() ? prevSpread(n) : n - 1);
                return;
              }
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
          rd.className = 'page fit-' + pref('fit', 'screen') + (pref('spread', '0') === '1' ? ' spread' : '');
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
        rd.className = (horiz ? 'horiz' : 'vert') + ' fit-' + fitMode();
        const fit = el('button', 'btn');
        const fitLabel = () => (fit.textContent = fitMode() === 'screen' ? '↔ Ancho' : '⤢ Pantalla');
        let onResize = null;
        fit.onclick = () => {
          setPref('fit', fitMode() === 'screen' ? 'width' : 'screen');
          rd.className = (horiz ? 'horiz' : 'vert') + ' fit-' + fitMode();
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
          nb.onclick = (ev) => { ev.stopPropagation(); openNext(); };
          foot.append(nb);
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
        bindMousePageDrag(
          () => (horiz ? 'x' : 'y'),
          () => { goToPage(n - 1); },
          () => { goToPage(n + 1); },
          true
        );

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
        observers._scroll = onScroll;

        rd.onclick = (ev) => {
          if (ev.target.closest?.('.bar, .next-btn, .mosaic')) return;
          rd.classList.toggle('ui-off');
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

          // PC: rueda vertical en página alta; al borde, cambiar página
          const onWheelH = (e) => {
            if (fitMode() !== 'width') return;
            const slot = slots[n];
            if (!slot || slot.dataset.tall !== '1') return;
            const canY = slot.scrollHeight > slot.clientHeight + 2;
            if (!canY) return;
            const atTop = slot.scrollTop <= 0;
            const atBot = slot.scrollTop + slot.clientHeight >= slot.scrollHeight - 2;
            if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBot)) return;
            if (Math.abs(e.deltaY) > 12) {
              e.preventDefault();
              snapTo(e.deltaY > 0 ? n + 1 : n - 1);
            }
          };
          rd.addEventListener('wheel', onWheelH, { passive: false });
          observers._wheel = onWheelH;
        }

        goToPage(n);
      }
      setCount();
      return () => {
        clearTimeout(uiTimer);
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
      try { unmount(); } catch (_) {}
      try { dropAll(); } catch (_) {}
      try { Promise.resolve(zr.close()).catch(() => {}); } catch (_) {}
    };
  }


  return { openComic, resolveQueue, reader };
}
