/**
 * Búsqueda y filtros avanzados.
 * Corpus se cachea al entrar; no se reconstruye al volver desde un cómic.
 */
export function createSearchFilters(d) {
  const {
    el, kv, go, show, stack,
    getLIB, fetchFiles, getFiles,
    openComic, sheet, bindLongPress,
    groupDisplayName, channelDisplayName, seriesDisplayName, comicDisplayName,
    comicDisplay, comicSourceName, groupSeries, seriesOverrideFor,
    isComicRead, readProgress, formatBytes, sizeLabel,
    parseComicCaption, parseQuality, sourceNameOf, flattenVersions,
    natural, appAlert,
    comicSheetOpts, seriesSheetOpts,
    comicCover, seriesCoverNode, channelCoverNode,
    locks, ART,
  } = d;

  const STATE_KEY = 'searchFilters:v1';
  const filterState = loadState();

  // Caché de corpus: solo se invalida al entrar con "Actualizar y buscar"
  let corpusCache = null;
  let corpusCacheAt = 0;

  function loadState() {
    try {
      const o = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
      return {
        editorial: o.editorial || '',
        channel: o.channel || '',
        series: o.series || '',
        quality: o.quality || '',
        ai: o.ai || '',
        read: o.read || '',
        format: o.format || '',
        ficha: o.ficha || '',
        fichaField: o.fichaField || '',
        q: o.q || '',
        groupMode: o.groupMode || 'series',
      };
    } catch {
      return {
        editorial: '', channel: '', series: '', quality: '', ai: '', read: '',
        format: '', ficha: '', fichaField: '', q: '', groupMode: 'series',
      };
    }
  }
  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(filterState)); } catch (_) {}
  }

  const FICHA_FIELDS = [
    ['', 'Cualquier campo'],
    ['originalTitle', 'Título original'],
    ['writer', 'Guionista'],
    ['artist', 'Dibujante'],
    ['date', 'Fecha'],
    ['description', 'Sinopsis'],
    ['publisher', 'Editorial'],
  ];

  function isFichaComplete(cap) {
    if (!cap) return false;
    return !!(cap.originalTitle && cap.writer && cap.artist && cap.date && cap.description && cap.publisher);
  }
  function isFichaIncomplete(cap, field) {
    if (!cap) return true;
    if (!field) return !isFichaComplete(cap);
    return !String(cap[field] || '').trim();
  }

  function fileFormat(f) {
    const n = String(f?.name || '').toLowerCase();
    if (/\.cbz$/i.test(n) || /\.zip$/i.test(n)) return 'cbz';
    if (/\.cbr$/i.test(n) || /\.rar$/i.test(n)) return 'cbr';
    if (/\.7z$/i.test(n) || /\.cb7$/i.test(n)) return '7z';
    return '';
  }

  function qualityOf(f) {
    try {
      const pq = parseQuality(sourceNameOf ? sourceNameOf(f) : (f?.name || ''));
      if (pq.ai) return { q: pq.q, ai: true };
      return { q: pq.q, ai: false };
    } catch {
      return { q: 'high', ai: false };
    }
  }

  function readStatus(ch, f) {
    try {
      if (isComicRead(ch.id, f.id)) return 'read';
      const p = readProgress?.(ch.id, f.id);
      if (p && (p.page > 0 || p.pct > 0)) return 'progress';
      return 'unread';
    } catch {
      return 'unread';
    }
  }

  function qualityBadge(it) {
    if (it.ai) return 'IA';
    if (it.quality === 'mid') return 'WebP';
    if (it.quality === 'low') return '2400px';
    return '';
  }

  function isBlockedComic(ch, f) {
    try {
      return !!(locks && locks.isContentRestricted && locks.isContentRestricted('comic', { ch, f }));
    } catch { return false; }
  }
  function isBlockedSeries(ch, seriesLabel) {
    try {
      return !!(locks && locks.isContentRestricted && locks.isContentRestricted('series', { ch, seriesLabel }));
    } catch { return false; }
  }
  function isBlockedChannel(ch) {
    try {
      return !!(locks && locks.isContentRestricted && locks.isContentRestricted('channel', ch));
    } catch { return false; }
  }
  function isBlockedGroup(g) {
    try {
      return !!(locks && locks.isContentRestricted && locks.isContentRestricted('group', g));
    } catch { return false; }
  }

  async function buildCorpus({ forceFetch = false, onProgress } = {}) {
    const LIB = (typeof getLIB === 'function' ? getLIB() : []) || [];
    const items = [];
    const total = LIB.length;
    for (let i = 0; i < LIB.length; i++) {
      const ch = LIB[i];
      onProgress?.(i, total, channelDisplayName?.(ch) || ch?.name || '');
      if (isBlockedGroup(ch.group) || isBlockedChannel(ch)) continue;
      let files = [];
      try {
        if (forceFetch && typeof fetchFiles === 'function') files = await fetchFiles(ch);
        else if (typeof getFiles === 'function') files = await getFiles(ch);
        else if (kv) files = (await kv.get('f:' + ch.id)) || [];
      } catch (_) { files = []; }
      const flat = typeof flattenVersions === 'function' ? flattenVersions(files) : (files || []);
      let groups = [];
      try {
        groups = groupSeries(files, ch.name, seriesOverrideFor?.(ch)) || [];
      } catch (_) {}
      const seriesOf = new Map();
      for (const g of groups) {
        for (const f of g.files || []) seriesOf.set(String(f.id), g.label);
      }
      for (const f of flat) {
        if (isBlockedComic(ch, f)) continue;
        const seriesLabel = seriesOf.get(String(f.id)) || '';
        if (seriesLabel && isBlockedSeries(ch, seriesLabel)) continue;
        let cap = {};
        try { cap = parseComicCaption(f?.caption || '') || {}; } catch (_) {}
        const qinfo = qualityOf(f);
        items.push({
          ch,
          f,
          seriesLabel,
          editorial: ch.group || 'Sin editorial',
          channelId: String(ch.id),
          channelName: channelDisplayName?.(ch) || ch.name || '',
          editorialName: groupDisplayName?.(ch.group) || ch.group || 'Sin editorial',
          seriesName: seriesLabel ? (seriesDisplayName?.(ch, seriesLabel) || seriesLabel) : '',
          title: comicDisplayName?.(ch, f, comicDisplay?.(comicSourceName?.(f) || f.name, ch.name) || f.name) || f.name,
          quality: qinfo.q,
          ai: !!qinfo.ai,
          format: fileFormat(f),
          read: readStatus(ch, f),
          cap,
          size: Number(f?.size) || 0,
        });
      }
    }
    onProgress?.(total, total, 'Listo');
    return items;
  }

  function applyFilters(items, st = filterState) {
    const q = String(st.q || '').trim().toLowerCase();
    return (items || []).filter((it) => {
      if (st.editorial && String(it.editorial) !== String(st.editorial)
        && String(it.editorialName) !== String(st.editorial)) return false;
      if (st.channel && String(it.channelId) !== String(st.channel)) return false;
      if (st.series) {
        const sn = String(st.series).toLowerCase();
        if (String(it.seriesLabel || '').toLowerCase() !== sn
          && String(it.seriesName || '').toLowerCase() !== sn) return false;
      }
      if (st.quality === 'high' && (it.quality !== 'high' || it.ai)) return false;
      if (st.quality === 'mid' && (it.quality !== 'mid' || it.ai)) return false;
      if (st.quality === 'low' && (it.quality !== 'low' || it.ai)) return false;
      if (st.quality === 'webp' && (it.ai || (it.quality !== 'mid' && it.quality !== 'low'))) return false;
      if (st.quality === 'nowebp' && (it.ai || it.quality !== 'high')) return false;
      if (st.ai === 'yes' && !it.ai) return false;
      if (st.ai === 'no' && it.ai) return false;
      if (st.read === 'unread' && it.read !== 'unread') return false;
      if (st.read === 'progress' && it.read !== 'progress') return false;
      if (st.read === 'read' && it.read !== 'read') return false;
      if (st.format && it.format !== st.format) return false;
      if (st.ficha === 'complete' && !isFichaComplete(it.cap)) return false;
      if (st.ficha === 'incomplete' && !isFichaIncomplete(it.cap, st.fichaField)) return false;
      if (q) {
        const hay = [
          it.title, it.seriesName, it.seriesLabel, it.channelName, it.editorialName,
          it.f?.name, it.cap?.writer, it.cap?.artist, it.cap?.originalTitle,
        ].map((x) => String(x || '').toLowerCase()).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function buildFilterOptions(items) {
    const editorials = new Map();
    const channels = new Map();
    const series = new Map();
    for (const it of items || []) {
      const eg = it.editorial || 'Sin editorial';
      if (!editorials.has(eg)) editorials.set(eg, it.editorialName || eg);
      if (!filterState.editorial || eg === filterState.editorial || it.editorialName === filterState.editorial) {
        channels.set(it.channelId, it.channelName);
        if ((!filterState.channel || it.channelId === filterState.channel) && it.seriesLabel) {
          series.set(it.seriesLabel, it.seriesName || it.seriesLabel);
        }
      }
    }
    const nat = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    return {
      editorials: [...editorials.entries()].sort((a, b) => nat(a[1], b[1])),
      channels: [...channels.entries()].sort((a, b) => nat(a[1], b[1])),
      series: [...series.entries()].sort((a, b) => nat(a[1], b[1])),
    };
  }

  /** Fila de filtro legible: etiqueta fija + select con fondo oscuro y texto claro */
  function mkFilterRow(label, value, options, onChange) {
    const row = el('div', 'sf-frow');
    row.append(el('span', 'sf-flab', label));
    const sel = el('select', 'sf-fsel');
    for (const [val, text] of options) {
      const o = el('option');
      o.value = val;
      o.textContent = text;
      if (String(val) === String(value)) o.selected = true;
      sel.append(o);
    }
    sel.onchange = () => onChange(sel.value);
    row.append(sel);
    return row;
  }

  function getApp() {
    return d.app || document.querySelector('#app');
  }

  function mountHeaderActions(onClear, onFocusSearch) {
    const act = document.querySelector('#actions');
    if (!act) return () => {};
    act.querySelectorAll('.sf-head-btn').forEach((n) => n.remove());
    const clear = el('button', 'btn sf-head-btn sf-head-clear', 'Limpiar');
    clear.type = 'button';
    clear.title = 'Limpiar filtros';
    clear.onclick = (ev) => { try { ev.stopPropagation(); } catch (_) {} onClear?.(); };
    const search = el('button', 'btn sf-head-btn sf-head-search');
    search.type = 'button';
    search.title = 'Palabras clave';
    search.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
    search.onclick = (ev) => { try { ev.stopPropagation(); } catch (_) {} onFocusSearch?.(); };
    const menu = act.querySelector('.menu-btn');
    if (menu) { act.insertBefore(clear, menu); act.insertBefore(search, menu); }
    else act.append(clear, search);
    return () => { try { clear.remove(); search.remove(); } catch (_) {} };
  }

  function appendCover(host, node) {
    if (!node) return;
    host.append(node);
    try { node._load?.(); } catch (_) {}
  }

  function renderFiltersView(opts = {}) {
    const forceFetch = !!opts.forceFetch;
    go('Búsqueda y Filtros', async (entry) => {
      // Marcar entrada para no reconstruir al volver del lector
      entry._sfView = true;
      entry._keepAlive = true;

      const root = el('div', 'sf-root');
      const status = el('p', 'sf-status', forceFetch ? 'Actualizando canales…' : 'Cargando…');
      root.append(status);
      try { getApp().replaceChildren(root); } catch (_) {}

      let corpus = corpusCache;
      if (forceFetch || !corpus) {
        try {
          corpus = await buildCorpus({
            forceFetch,
            onProgress: (i, t, name) => {
              status.textContent = t ? `Actualizando ${i} / ${t}: ${name}` : 'Cargando…';
            },
          });
          corpusCache = corpus;
          corpusCacheAt = Date.now();
        } catch (e) {
          status.textContent = 'Error: ' + (e?.message || e);
          return;
        }
      }

      let keywordOpen = !!filterState.q;
      let unmountHead = null;

      const openComicMenu = (it, redraw) => {
        if (typeof sheet !== 'function' || typeof comicSheetOpts !== 'function') return;
        const opts = comicSheetOpts(it.ch, it.f, it.title, redraw || (() => {}));
        if (opts?.length) sheet(it.title, opts);
      };

      const paintComicsList = (host, list) => {
        const queue = list.map((it) => it.f);
        for (const it of list) {
          const row = el('button', 'sf-comic-row');
          row.type = 'button';
          const cov = el('div', 'sf-comic-cover');
          try {
            if (typeof comicCover === 'function') appendCover(cov, comicCover(it.ch, it.f));
          } catch (_) {}
          const meta = el('div', 'sf-comic-meta');
          const titleLine = el('div', 'sf-comic-title');
          titleLine.append(el('b', '', it.title || it.f?.name || ''));
          const badge = qualityBadge(it);
          if (badge) titleLine.append(el('span', 'sf-badge', badge));
          meta.append(titleLine);
          const sub = [it.seriesName || it.seriesLabel, it.channelName].filter(Boolean).join(' · ');
          if (sub) meta.append(el('small', '', sub));
          meta.append(el('small', 'sf-comic-bits', formatBytes(it.size)));
          row.append(cov, meta);

          // Click / tap = abrir
          row.onclick = (ev) => {
            try { ev.preventDefault(); } catch (_) {}
            openComic?.(it.ch, it.f, queue);
          };
          // Click derecho = menú (desktop)
          row.oncontextmenu = (ev) => {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
            openComicMenu(it, () => paint());
          };
          // Long press = menú (móvil)
          if (typeof bindLongPress === 'function') {
            bindLongPress(row, () => openComicMenu(it, () => paint()));
          }
          host.append(row);
        }
      };

      /** Serie: cabecera con portada + acordeón de cómics */
      const paintSeriesBlock = (host, ch, seriesLabel, seriesName, items) => {
        const block = el('div', 'sf-group');
        const head = el('button', 'sf-group-head');
        head.type = 'button';
        const cov = el('div', 'sf-group-cover sf-group-cover-series');
        try {
          if (typeof seriesCoverNode === 'function') {
            appendCover(cov, seriesCoverNode(ch, seriesLabel, items.map((x) => x.f), items.length));
          }
        } catch (_) {}
        const arrow = el('span', 'sf-group-arrow', '▶');
        const text = el('div', 'sf-group-text');
        const n = items.length;
        text.append(el('b', '', seriesName || seriesLabel || 'Serie'));
        text.append(el('small', '', n + (n === 1 ? ' número' : ' números')
          + (items[0]?.channelName ? ' · ' + items[0].channelName : '')));
        head.append(cov, text, arrow);
        const body = el('div', 'sf-group-body');
        body.hidden = true;

        head.onclick = (ev) => {
          try { ev.preventDefault(); } catch (_) {}
          body.hidden = !body.hidden;
          arrow.textContent = body.hidden ? '▶' : '▼';
          if (!body.hidden && !body.dataset.filled) {
            body.dataset.filled = '1';
            paintComicsList(body, items);
          }
        };
        head.oncontextmenu = (ev) => {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
          if (typeof sheet === 'function' && typeof seriesSheetOpts === 'function' && seriesLabel) {
            const files = items.map((x) => x.f);
            sheet(seriesName || seriesLabel, seriesSheetOpts(ch, seriesLabel, files, () => paint()));
          }
        };
        if (typeof bindLongPress === 'function') {
          bindLongPress(head, () => {
            if (typeof sheet === 'function' && typeof seriesSheetOpts === 'function' && seriesLabel) {
              const files = items.map((x) => x.f);
              sheet(seriesName || seriesLabel, seriesSheetOpts(ch, seriesLabel, files, () => paint()));
            }
          });
        }
        block.append(head, body);
        host.append(block);
      };

      /** Canal: cabecera con portada → al abrir lista SERIES → cada serie abre cómics */
      const paintChannelBlock = (host, ch, channelName, items) => {
        const block = el('div', 'sf-group');
        const head = el('button', 'sf-group-head');
        head.type = 'button';
        const cov = el('div', 'sf-group-cover sf-group-cover-channel');
        try {
          if (typeof channelCoverNode === 'function') {
            appendCover(cov, channelCoverNode(ch, items.map((x) => x.f)));
          }
        } catch (_) {}
        const arrow = el('span', 'sf-group-arrow', '▶');
        const text = el('div', 'sf-group-text');
        // Contar series distintas
        const seriesKeys = new Set(items.map((it) => it.seriesLabel || ('__c:' + it.f.id)));
        text.append(el('b', '', channelName || ch?.name || 'Canal'));
        text.append(el('small', '',
          seriesKeys.size + (seriesKeys.size === 1 ? ' serie' : ' series')
          + ' · ' + items.length + (items.length === 1 ? ' cómic' : ' cómics')
          + (items[0]?.editorialName ? ' · ' + items[0].editorialName : '')));
        head.append(cov, text, arrow);
        const body = el('div', 'sf-group-body');
        body.hidden = true;

        const fillSeries = () => {
          if (body.dataset.filled) return;
          body.dataset.filled = '1';
          // Agrupar por serie dentro del canal
          const bySeries = new Map();
          for (const it of items) {
            const key = it.seriesLabel || ('__solo__' + it.f.id);
            if (!bySeries.has(key)) {
              bySeries.set(key, {
                seriesLabel: it.seriesLabel,
                seriesName: it.seriesName || it.seriesLabel || it.title,
                items: [],
              });
            }
            bySeries.get(key).items.push(it);
          }
          const nat = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
          const list = [...bySeries.values()].sort((a, b) => nat(a.seriesName, b.seriesName));
          for (const g of list) {
            if (g.seriesLabel) {
              paintSeriesBlock(body, ch, g.seriesLabel, g.seriesName, g.items);
            } else {
              // Cómics sueltos sin serie
              paintComicsList(body, g.items);
            }
          }
        };

        head.onclick = (ev) => {
          try { ev.preventDefault(); } catch (_) {}
          body.hidden = !body.hidden;
          arrow.textContent = body.hidden ? '▶' : '▼';
          if (!body.hidden) fillSeries();
        };
        // Long press canal: info básica si no hay sheet de canal
        head.oncontextmenu = (ev) => {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
        };
        if (typeof bindLongPress === 'function') {
          bindLongPress(head, () => {});
        }
        block.append(head, body);
        host.append(block);
      };

      const paintGroupedSeries = (host, list) => {
        const map = new Map();
        for (const it of list) {
          const key = it.channelId + '::' + (it.seriesLabel || '__solo__' + it.f.id);
          if (!map.has(key)) {
            map.set(key, {
              ch: it.ch,
              seriesLabel: it.seriesLabel,
              seriesName: it.seriesName || it.seriesLabel || it.title,
              items: [],
            });
          }
          map.get(key).items.push(it);
        }
        const nat = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
        const groups = [...map.values()].sort((a, b) => nat(a.seriesName, b.seriesName));
        for (const g of groups) {
          if (g.seriesLabel) paintSeriesBlock(host, g.ch, g.seriesLabel, g.seriesName, g.items);
          else paintComicsList(host, g.items);
        }
      };

      const paintGroupedChannels = (host, list) => {
        const map = new Map();
        for (const it of list) {
          if (!map.has(it.channelId)) {
            map.set(it.channelId, { ch: it.ch, channelName: it.channelName, items: [] });
          }
          map.get(it.channelId).items.push(it);
        }
        const nat = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
        const groups = [...map.values()].sort((a, b) => nat(a.channelName, b.channelName));
        for (const g of groups) paintChannelBlock(host, g.ch, g.channelName, g.items);
      };

      const paint = () => {
        saveState();
        const filtered = applyFilters(corpus, filterState);
        const optsSel = buildFilterOptions(corpus);
        root.replaceChildren();
        root.className = 'sf-root';

        // —— Panel filtros (filas legibles) ——
        const panel = el('div', 'sf-panel');
        const grid = el('div', 'sf-fgrid');
        grid.append(mkFilterRow('Editorial', filterState.editorial,
          [['', 'Todas'], ...optsSel.editorials.map(([k, v]) => [k, v])],
          (v) => { filterState.editorial = v; filterState.channel = ''; filterState.series = ''; paint(); }));
        grid.append(mkFilterRow('Canal', filterState.channel,
          [['', 'Todos'], ...optsSel.channels.map(([k, v]) => [k, v])],
          (v) => { filterState.channel = v; filterState.series = ''; paint(); }));
        grid.append(mkFilterRow('Serie', filterState.series,
          [['', 'Todas'], ...optsSel.series.map(([k, v]) => [k, v])],
          (v) => { filterState.series = v; paint(); }));
        grid.append(mkFilterRow('Calidad', filterState.quality, [
          ['', 'Cualquiera'], ['high', 'Alta (Original)'], ['mid', 'Media [WebP]'],
          ['low', 'Baja [2400px]'], ['webp', 'Cualquier WebP'], ['nowebp', 'Sin WebP'],
        ], (v) => { filterState.quality = v; paint(); }));
        grid.append(mkFilterRow('IA', filterState.ai, [
          ['', 'Cualquiera'], ['yes', 'Con mejora IA'], ['no', 'Sin mejora IA'],
        ], (v) => { filterState.ai = v; paint(); }));
        grid.append(mkFilterRow('Estado', filterState.read, [
          ['', 'Cualquiera'], ['unread', 'No leídos'], ['progress', 'En curso'], ['read', 'Leídos'],
        ], (v) => { filterState.read = v; paint(); }));
        grid.append(mkFilterRow('Formato', filterState.format, [
          ['', 'Cualquiera'], ['cbz', 'CBZ / ZIP'], ['cbr', 'CBR / RAR'], ['7z', '7Z'],
        ], (v) => { filterState.format = v; paint(); }));
        grid.append(mkFilterRow('Fichas', filterState.ficha, [
          ['', 'Cualquiera'], ['complete', 'Completa'], ['incomplete', 'Incompleta'],
        ], (v) => { filterState.ficha = v; if (v !== 'incomplete') filterState.fichaField = ''; paint(); }));
        if (filterState.ficha === 'incomplete') {
          grid.append(mkFilterRow('Campo vacío', filterState.fichaField, FICHA_FIELDS,
            (v) => { filterState.fichaField = v; paint(); }));
        }
        panel.append(grid);

        const qRow = el('div', 'sf-qrow');
        qRow.hidden = !keywordOpen && !filterState.q;
        const qInp = el('input', 'sf-qinput');
        qInp.type = 'search';
        qInp.placeholder = 'Palabras clave: título, guionista, archivo…';
        qInp.value = filterState.q || '';
        qInp.autocomplete = 'off';
        let qTimer = null;
        qInp.oninput = () => {
          clearTimeout(qTimer);
          qTimer = setTimeout(() => { filterState.q = qInp.value; paint(); }, 220);
        };
        qRow.append(qInp);
        panel.append(qRow);
        root.append(panel);

        try { unmountHead?.(); } catch (_) {}
        unmountHead = mountHeaderActions(
          () => {
            Object.assign(filterState, {
              editorial: '', channel: '', series: '', quality: '', ai: '', read: '',
              format: '', ficha: '', fichaField: '', q: '',
            });
            keywordOpen = false;
            paint();
          },
          () => {
            keywordOpen = true;
            paint();
            requestAnimationFrame(() => {
              try { root.querySelector('.sf-qinput')?.focus(); } catch (_) {}
            });
          }
        );

        // —— Resumen ——
        const bytes = filtered.reduce((s, it) => s + (it.size || 0), 0);
        const summary = el('div', 'sf-summary');
        summary.append(el('div', 'sf-summary-count',
          filtered.length + (filtered.length === 1 ? ' cómic encontrado' : ' cómics encontrados')
          + ' (' + formatBytes(bytes) + ')'
        ));
        const tabs = el('div', 'sf-tabs');
        for (const [mode, lab] of [
          ['comics', 'Ver: Cómics'],
          ['series', 'Agrupar por Series'],
          ['channels', 'Agrupar por Canales'],
        ]) {
          const b = el('button', 'sf-tab' + (filterState.groupMode === mode ? ' on' : ''), lab);
          b.type = 'button';
          b.onclick = () => { filterState.groupMode = mode; paint(); };
          tabs.append(b);
        }
        summary.append(tabs);
        root.append(summary);

        // —— Resultados ——
        const results = el('div', 'sf-results');
        if (!filtered.length) {
          results.append(el('p', 'sf-empty', 'Sin resultados con estos filtros.'));
        } else if (filterState.groupMode === 'comics') {
          paintComicsList(results, filtered);
        } else if (filterState.groupMode === 'series') {
          paintGroupedSeries(results, filtered);
        } else {
          paintGroupedChannels(results, filtered);
        }
        root.append(results);
      };

      paint();
    });
  }

  function showSearchEntryDialog() {
    document.querySelector('.sf-entry-dialog')?.remove();
    const frame = el('div', 'info-frame sf-entry-dialog');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Búsqueda y filtros'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      corpusCache
        ? 'Hay datos en caché. «Búsqueda rápida» los reutiliza; «Actualizar y buscar» vuelve a leer Telegram.'
        : 'Elige cómo cargar los datos de la biblioteca.'
    ));
    const act = el('div', 'edit-actions');
    act.style.flexDirection = 'column';
    act.style.gap = '8px';
    const full = el('button', 'btn edit-save', 'Actualizar y buscar');
    full.type = 'button';
    full.onclick = () => { frame.remove(); corpusCache = null; renderFiltersView({ forceFetch: true }); };
    const quick = el('button', 'btn', 'Búsqueda rápida');
    quick.type = 'button';
    quick.onclick = () => { frame.remove(); renderFiltersView({ forceFetch: false }); };
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.type = 'button';
    cancel.onclick = () => frame.remove();
    act.append(full, quick, cancel);
    body.append(act);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }

  function invalidateCorpus() { corpusCache = null; }

  return {
    renderFiltersView,
    applyFilters,
    filterState,
    buildFilterOptions,
    showSearchEntryDialog,
    buildCorpus,
    invalidateCorpus,
  };
}
