/**
 * Búsqueda y filtros avanzados (módulo independiente).
 * Layout: cabecera app + chips de filtro + resumen + pestañas + frame de resultados con scroll.
 */
export function createSearchFilters(d) {
  const {
    el, kv, go, show, stack,
    getLIB, fetchFiles, getFiles,
    openComic, sheet, bindLongPress,
    groupDisplayName, channelDisplayName, seriesDisplayName, comicDisplayName,
    comicDisplay, comicSourceName, groupSeries, seriesOverrideFor,
    isComicRead, readProgress, formatBytes, sizeLabel,
    splitStats, parseComicCaption, parseQuality, sourceNameOf, flattenVersions,
    comicNeedsCvFill, parseComicName, issueDisplay,
    natural, appAlert,
    comicSheetOpts, seriesSheetOpts,
    comicCover, seriesCoverNode, channelCoverNode,
  } = d;

  const STATE_KEY = 'searchFilters:v1';
  const filterState = loadState();

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
        scrollY: o.scrollY || 0,
      };
    } catch {
      return {
        editorial: '', channel: '', series: '', quality: '', ai: '', read: '',
        format: '', ficha: '', fichaField: '', q: '', groupMode: 'series', scrollY: 0,
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

  async function buildCorpus({ forceFetch = false, onProgress } = {}) {
    const LIB = (typeof getLIB === 'function' ? getLIB() : []) || [];
    const items = [];
    const total = LIB.length;
    for (let i = 0; i < LIB.length; i++) {
      const ch = LIB[i];
      onProgress?.(i, total, channelDisplayName?.(ch) || ch?.name || '');
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
        const seriesLabel = seriesOf.get(String(f.id)) || '';
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

  /** Chip compacto: etiqueta + select en una sola pieza */
  function mkChip(shortLabel, value, options, onChange) {
    const wrap = el('label', 'sf-chip' + (value ? ' sf-chip-on' : ''));
    const lab = el('span', 'sf-chip-lab', shortLabel);
    const sel = el('select', 'sf-chip-sel');
    for (const [val, text] of options) {
      const o = el('option');
      o.value = val;
      o.textContent = text;
      if (String(val) === String(value)) o.selected = true;
      sel.append(o);
    }
    sel.onchange = () => onChange(sel.value);
    wrap.append(lab, sel);
    return wrap;
  }

  function getApp() {
    return d.app || document.querySelector('#app');
  }

  /** Botones Limpiar + lupa en #actions mientras estamos en esta vista */
  function mountHeaderActions(onClear, onFocusSearch) {
    const act = document.querySelector('#actions');
    if (!act) return () => {};
    const prev = [...act.querySelectorAll('.sf-head-btn')];
    prev.forEach((n) => n.remove());
    const clear = el('button', 'btn sf-head-btn sf-head-clear', 'Limpiar');
    clear.type = 'button';
    clear.title = 'Limpiar filtros';
    clear.onclick = (ev) => { try { ev.stopPropagation(); } catch (_) {} onClear?.(); };
    const search = el('button', 'btn sf-head-btn sf-head-search');
    search.type = 'button';
    search.title = 'Palabras clave';
    search.setAttribute('aria-label', 'Palabras clave');
    search.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
    search.onclick = (ev) => { try { ev.stopPropagation(); } catch (_) {} onFocusSearch?.(); };
    const menu = act.querySelector('.menu-btn');
    if (menu) {
      act.insertBefore(clear, menu);
      act.insertBefore(search, menu);
    } else {
      act.append(clear, search);
    }
    return () => {
      try { clear.remove(); search.remove(); } catch (_) {}
    };
  }

  function renderFiltersView(opts = {}) {
    const forceFetch = !!opts.forceFetch;
    go('Búsqueda y Filtros', async (entry) => {
      const root = el('div', 'sf-root');
      const status = el('p', 'sf-status', forceFetch ? 'Actualizando canales…' : 'Cargando…');
      root.append(status);
      try { getApp().replaceChildren(root); } catch (_) {}

      let corpus = [];
      try {
        corpus = await buildCorpus({
          forceFetch,
          onProgress: (i, t, name) => {
            status.textContent = t ? `Actualizando ${i} / ${t}: ${name}` : 'Cargando…';
          },
        });
      } catch (e) {
        status.textContent = 'Error: ' + (e?.message || e);
        return;
      }

      let keywordOpen = !!filterState.q;
      let unmountHead = null;

      const paintComicsList = (host, list) => {
        const queue = list.map((it) => it.f);
        for (const it of list) {
          const row = el('button', 'sf-comic-row');
          row.type = 'button';
          // Portada miniatura
          const cov = el('div', 'sf-comic-cover');
          try {
            if (typeof comicCover === 'function') {
              const node = comicCover(it.ch, it.f);
              if (node) {
                cov.append(node);
                node._load?.();
              }
            }
          } catch (_) {}
          const meta = el('div', 'sf-comic-meta');
          const titleLine = el('div', 'sf-comic-title');
          titleLine.append(el('b', '', it.title || it.f?.name || ''));
          const badge = qualityBadge(it);
          if (badge) titleLine.append(el('span', 'sf-badge', badge));
          meta.append(titleLine);
          const sub = [it.seriesName || it.seriesLabel, it.channelName]
            .filter(Boolean).join(' · ');
          if (sub) meta.append(el('small', '', sub));
          meta.append(el('small', 'sf-comic-bits', formatBytes(it.size)));
          row.append(cov, meta);
          row.onclick = () => openComic?.(it.ch, it.f, queue);
          if (typeof bindLongPress === 'function' && typeof sheet === 'function') {
            bindLongPress(row, () => {
              const opts = comicSheetOpts
                ? comicSheetOpts(it.ch, it.f, it.title, () => paint())
                : [];
              if (opts.length) sheet(it.title, opts);
            });
          }
          host.append(row);
        }
      };

      const paintGrouped = (host, list, mode) => {
        const map = new Map();
        for (const it of list) {
          const key = mode === 'series'
            ? (it.channelId + '::' + (it.seriesLabel || '__solo__' + it.f.id))
            : it.channelId;
          if (!map.has(key)) {
            map.set(key, {
              ch: it.ch,
              seriesLabel: it.seriesLabel,
              label: mode === 'series'
                ? (it.seriesName || it.seriesLabel || it.title)
                : it.channelName,
              sub: mode === 'series' ? it.channelName : it.editorialName,
              items: [],
            });
          }
          map.get(key).items.push(it);
        }
        const nat = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
        const groups = [...map.values()].sort((a, b) => nat(a.label, b.label));
        for (const g of groups) {
          const block = el('div', 'sf-group');
          const head = el('button', 'sf-group-head');
          head.type = 'button';
          const arrow = el('span', 'sf-group-arrow', '▼');
          const text = el('div', 'sf-group-text');
          const n = g.items.length;
          text.append(el('b', '', (mode === 'series' ? 'Serie: ' : 'Canal: ') + g.label));
          text.append(el('small', '', (g.sub ? g.sub + ' · ' : '') + n + (n === 1 ? ' número' : ' números')));
          head.append(arrow, text);
          const body = el('div', 'sf-group-body');
          // Abierto por defecto si hay pocos grupos
          const open = groups.length <= 6;
          body.hidden = !open;
          arrow.textContent = open ? '▼' : '▶';
          head.onclick = () => {
            body.hidden = !body.hidden;
            arrow.textContent = body.hidden ? '▶' : '▼';
          };
          if (typeof bindLongPress === 'function' && typeof sheet === 'function') {
            bindLongPress(head, () => {
              if (mode === 'series' && seriesSheetOpts && g.seriesLabel) {
                const files = g.items.map((x) => x.f);
                sheet(g.label, seriesSheetOpts(g.ch, g.seriesLabel, files, () => paint()));
              }
            });
          }
          paintComicsList(body, g.items);
          block.append(head, body);
          host.append(block);
        }
      };

      const paint = () => {
        saveState();
        const filtered = applyFilters(corpus, filterState);
        const optsSel = buildFilterOptions(corpus);
        root.replaceChildren();
        root.className = 'sf-root';

        // —— Filtros en chips ——
        const panel = el('div', 'sf-panel');
        const chips = el('div', 'sf-chips');

        chips.append(mkChip('Editorial', filterState.editorial,
          [['', 'Todas'], ...optsSel.editorials.map(([k, v]) => [k, v])],
          (v) => { filterState.editorial = v; filterState.channel = ''; filterState.series = ''; paint(); }));

        chips.append(mkChip('Canal', filterState.channel,
          [['', 'Todos'], ...optsSel.channels.map(([k, v]) => [k, v])],
          (v) => { filterState.channel = v; filterState.series = ''; paint(); }));

        chips.append(mkChip('Serie', filterState.series,
          [['', 'Todas'], ...optsSel.series.map(([k, v]) => [k, v])],
          (v) => { filterState.series = v; paint(); }));

        chips.append(mkChip('Calidad', filterState.quality, [
          ['', 'Cualquiera'],
          ['high', 'Alta'],
          ['mid', 'WebP'],
          ['low', '2400px'],
          ['webp', 'Cualquier WebP'],
          ['nowebp', 'Sin WebP'],
        ], (v) => { filterState.quality = v; paint(); }));

        chips.append(mkChip('IA', filterState.ai, [
          ['', 'Cualquiera'], ['yes', 'Con IA'], ['no', 'Sin IA'],
        ], (v) => { filterState.ai = v; paint(); }));

        chips.append(mkChip('Estado', filterState.read, [
          ['', 'Cualquiera'], ['unread', 'No leídos'], ['progress', 'En curso'], ['read', 'Leídos'],
        ], (v) => { filterState.read = v; paint(); }));

        chips.append(mkChip('Formato', filterState.format, [
          ['', 'Cualquiera'], ['cbz', 'CBZ'], ['cbr', 'CBR'], ['7z', '7Z'],
        ], (v) => { filterState.format = v; paint(); }));

        chips.append(mkChip('Fichas', filterState.ficha, [
          ['', 'Cualquiera'], ['complete', 'Completa'], ['incomplete', 'Incompleta'],
        ], (v) => { filterState.ficha = v; if (v !== 'incomplete') filterState.fichaField = ''; paint(); }));

        if (filterState.ficha === 'incomplete') {
          chips.append(mkChip('Campo vacío', filterState.fichaField, FICHA_FIELDS,
            (v) => { filterState.fichaField = v; paint(); }));
        }

        panel.append(chips);

        // Palabras clave (oculto hasta pulsar lupa o si ya hay texto)
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

        // Cabecera Limpiar + lupa
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

        // —— Pestañas Ver ——
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

        // —— Frame resultados (scroll independiente) ——
        const results = el('div', 'sf-results');
        if (!filtered.length) {
          results.append(el('p', 'sf-empty', 'Sin resultados con estos filtros.'));
        } else if (filterState.groupMode === 'comics') {
          paintComicsList(results, filtered);
        } else if (filterState.groupMode === 'series') {
          paintGrouped(results, filtered, 'series');
        } else {
          paintGrouped(results, filtered, 'channels');
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
    body.append(el('p', 'cover-pick-hint', 'Elige cómo cargar los datos de la biblioteca.'));
    const act = el('div', 'edit-actions');
    act.style.flexDirection = 'column';
    act.style.gap = '8px';
    const full = el('button', 'btn edit-save', 'Actualizar y buscar');
    full.type = 'button';
    full.onclick = () => { frame.remove(); renderFiltersView({ forceFetch: true }); };
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

  return {
    renderFiltersView,
    applyFilters,
    filterState,
    buildFilterOptions,
    showSearchEntryDialog,
    buildCorpus,
  };
}
