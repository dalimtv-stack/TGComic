/**
 * Búsqueda y filtros avanzados.
 * Corpus cacheado: al volver desde un cómic NO se reconstruye.
 * WebP / IA anidados bajo el cómic original (collapseVersions).
 */
export function createSearchFilters(d) {
  const {
    el, kv, go, show, stack,
    getLIB, fetchFiles, getFiles,
    openComic, sheet, bindLongPress,
    groupDisplayName, channelDisplayName, seriesDisplayName, comicDisplayName,
    comicDisplay, comicSourceName, groupSeries, seriesOverrideFor,
    isComicRead, readProgress, formatBytes, sizeLabel,
    parseComicCaption, parseQuality, sourceNameOf,
    collapseVersions, flattenVersions, aiLabel, QUALITY_LABEL,
    natural, appAlert,
    comicSheetOpts, seriesSheetOpts,
    comicCover, seriesCoverNode, channelCoverNode,
    locks, ART,
    showChannelInfo, showEditChannel,
  } = d;

  const STATE_KEY = 'searchFilters:v1';
  const filterState = loadState();

  /** Caché global entre visitas a la vista (no se borra al abrir un cómic). */
  let corpusCache = null;

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
    const n = String(sourceNameOf?.(f) || f?.name || '').toLowerCase();
    if (/\.cbz$/i.test(n) || /\.zip$/i.test(n)) return 'cbz';
    if (/\.cbr$/i.test(n) || /\.rar$/i.test(n)) return 'cbr';
    if (/\.7z$/i.test(n) || /\.cb7$/i.test(n)) return '7z';
    return '';
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

  function isBlockedComic(ch, f) {
    try { return !!(locks?.isContentRestricted?.('comic', { ch, f })); } catch { return false; }
  }
  function isBlockedSeries(ch, seriesLabel) {
    try { return !!(locks?.isContentRestricted?.('series', { ch, seriesLabel })); } catch { return false; }
  }
  function isBlockedChannel(ch) {
    try { return !!(locks?.isContentRestricted?.('channel', ch)); } catch { return false; }
  }
  function isBlockedGroup(g) {
    try { return !!(locks?.isContentRestricted?.('group', g)); } catch { return false; }
  }

  /** Título unificado (mismo en todas las vistas). */
  function itemTitle(ch, f) {
    try {
      const src = comicSourceName?.(f) || f?.name || '';
      const base = comicDisplay?.(src, ch?.name) || src;
      return comicDisplayName?.(ch, f, base) || base || f?.name || '';
    } catch {
      return f?.name || '';
    }
  }

  /**
   * Corpus: UNA entrada por cómic lógico (collapseVersions).
   * variants / ai quedan anidados; no cuentan como series ni cómics extra.
   */
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

      // Listado ya puede venir colapsado desde fetchFiles; asegurar colapso
      const collapsed = typeof collapseVersions === 'function'
        ? collapseVersions(typeof flattenVersions === 'function' ? flattenVersions(files) : files)
        : files;

      let groups = [];
      try {
        groups = groupSeries(collapsed, ch.name, seriesOverrideFor?.(ch)) || [];
      } catch (_) {}
      const seriesOf = new Map();
      for (const g of groups) {
        for (const f of g.files || []) seriesOf.set(String(f.id), g.label);
        // también mapear variants / ai al mismo series
        for (const f of g.files || []) {
          if (f.variants) {
            for (const q of Object.keys(f.variants)) {
              const v = f.variants[q];
              if (v?.id != null) seriesOf.set(String(v.id), g.label);
            }
          }
          if (Array.isArray(f.ai)) {
            for (const a of f.ai) {
              if (a?.id != null) seriesOf.set(String(a.id), g.label);
            }
          }
        }
      }

      for (const f of collapsed) {
        if (isBlockedComic(ch, f)) continue;
        const seriesLabel = seriesOf.get(String(f.id)) || '';
        if (seriesLabel && isBlockedSeries(ch, seriesLabel)) continue;

        let cap = {};
        try { cap = parseComicCaption(f?.caption || '') || {}; } catch (_) {}

        // Calidad del representante (alta si hay variants)
        let q = 'high';
        let ai = false;
        try {
          const pq = parseQuality(sourceNameOf?.(f) || f?.name || '');
          q = pq.q || 'high';
          ai = !!pq.ai;
        } catch (_) {}

        const hasWebpMid = !!(f.variants?.mid);
        const hasWebpLow = !!(f.variants?.low);
        const hasAi = Array.isArray(f.ai) && f.ai.length > 0;
        const aiModels = hasAi
          ? f.ai.map((a) => {
              try { return (aiLabel && aiLabel(sourceNameOf?.(a) || a.name)) || 'Mejora IA'; }
              catch { return 'Mejora IA'; }
            })
          : [];

        items.push({
          ch,
          f,
          seriesLabel,
          editorial: ch.group || 'Sin editorial',
          channelId: String(ch.id),
          channelName: channelDisplayName?.(ch) || ch.name || '',
          editorialName: groupDisplayName?.(ch.group) || ch.group || 'Sin editorial',
          seriesName: seriesLabel ? (seriesDisplayName?.(ch, seriesLabel) || seriesLabel) : '',
          title: itemTitle(ch, f),
          quality: q,
          ai,
          hasWebpMid,
          hasWebpLow,
          hasAi,
          aiModels,
          variants: f.variants || null,
          aiList: hasAi ? f.ai : [],
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
      // Calidad: filtrar por lo disponible en el grupo (original + variants)
      if (st.quality === 'high') {
        // tiene original alta (no es solo webp)
        if (it.quality !== 'high' && !it.variants?.high) return false;
      }
      if (st.quality === 'mid' && !it.hasWebpMid && it.quality !== 'mid') return false;
      if (st.quality === 'low' && !it.hasWebpLow && it.quality !== 'low') return false;
      if (st.quality === 'webp' && !it.hasWebpMid && !it.hasWebpLow
        && it.quality !== 'mid' && it.quality !== 'low') return false;
      if (st.quality === 'nowebp' && (it.hasWebpMid || it.hasWebpLow
        || it.quality === 'mid' || it.quality === 'low')) return false;
      if (st.ai === 'yes' && !it.hasAi && !it.ai) return false;
      if (st.ai === 'no' && (it.hasAi || it.ai)) return false;
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
          ...(it.aiModels || []),
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
      // Canal solo si hay editorial seleccionada (o listamos todos para construir opciones filtradas)
      if (!filterState.editorial || eg === filterState.editorial || it.editorialName === filterState.editorial) {
        channels.set(it.channelId, it.channelName);
        if (filterState.channel && it.channelId === filterState.channel && it.seriesLabel) {
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

  function mkFilterRow(label, value, options, onChange, { disabled = false } = {}) {
    const row = el('div', 'sf-frow' + (disabled ? ' sf-frow-disabled' : ''));
    row.append(el('span', 'sf-flab', label));
    const sel = el('select', 'sf-fsel');
    sel.disabled = !!disabled;
    for (const [val, text] of options) {
      const o = el('option');
      o.value = val;
      o.textContent = text;
      if (String(val) === String(value)) o.selected = true;
      sel.append(o);
    }
    if (!disabled) sel.onchange = () => onChange(sel.value);
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

  function qualityBadges(it) {
    const wrap = el('span', 'sf-badges');
    if (it.hasWebpMid || it.quality === 'mid') {
      wrap.append(el('span', 'sf-badge sf-badge-webp', 'WebP'));
    }
    if (it.hasWebpLow || it.quality === 'low') {
      wrap.append(el('span', 'sf-badge sf-badge-low', '2400px'));
      wrap.append(el('span', 'sf-badge sf-badge-webp', 'WebP'));
    }
    if (it.hasAi || it.ai) {
      const models = it.aiModels?.length ? it.aiModels : ['Mejora IA'];
      for (const m of models) {
        wrap.append(el('span', 'sf-badge sf-badge-ai', 'IA'));
        if (m && m !== 'Mejora IA') wrap.append(el('span', 'sf-badge sf-badge-model', m));
      }
    }
    return wrap.childNodes.length ? wrap : null;
  }

  function renderFiltersView(opts = {}) {
    // forceFetch solo cuenta la PRIMERA vez que se monta esta entrada de stack.
    // Al volver del visor, show() re-ejecuta render: NUNCA debe volver a scrapear.
    const wantFetch = !!opts.forceFetch;
    if (wantFetch) corpusCache = null;

    go('Búsqueda y Filtros', async (entry) => {
      entry._sfView = true;

      // Ya montada esta entrada (p. ej. vuelta desde el visor) → solo repintar
      if (entry._sfBuilt && corpusCache) {
        paintUI(entry, corpusCache);
        return;
      }

      // Hay caché de una visita anterior y no pedimos actualizar → usarla sin red
      if (corpusCache && !wantFetch) {
        entry._sfBuilt = true;
        paintUI(entry, corpusCache);
        return;
      }

      const root = el('div', 'sf-root');
      const status = el('p', 'sf-status', wantFetch ? 'Actualizando canales…' : 'Cargando…');
      root.append(status);
      try { getApp().replaceChildren(root); } catch (_) {}

      let corpus;
      try {
        corpus = await buildCorpus({
          forceFetch: wantFetch,
          onProgress: (i, tot, name) => {
            status.textContent = tot ? `Actualizando ${i} / ${tot}: ${name}` : 'Cargando…';
          },
        });
        corpusCache = corpus;
      } catch (e) {
        status.textContent = 'Error: ' + (e?.message || e);
        return;
      }

      entry._sfBuilt = true;
      paintUI(entry, corpus);
    });
  }

  function paintUI(entry, corpus) {
    const root = el('div', 'sf-root');
    entry._sfRoot = root;
    try { getApp().replaceChildren(root); } catch (_) {}

    let keywordOpen = !!filterState.q;
    let unmountHead = null;

    const openComicMenu = (it, fileOverride) => {
      const f = fileOverride || it.f;
      if (typeof sheet !== 'function' || typeof comicSheetOpts !== 'function') return;
      const title = itemTitle(it.ch, f);
      const opts = comicSheetOpts(it.ch, f, title, () => paintUI(entry, corpus));
      if (opts?.length) sheet(title, opts);
    };

    const openSeriesMenu = (ch, seriesLabel, seriesName, items) => {
      if (typeof sheet !== 'function' || typeof seriesSheetOpts !== 'function' || !seriesLabel) return;
      const files = items.map((x) => x.f);
      sheet(seriesName || seriesLabel, seriesSheetOpts(ch, seriesLabel, files, () => paintUI(entry, corpus)));
    };

    const openChannelMenu = (ch, channelName) => {
      if (typeof sheet !== 'function') return;
      const opts = [];
      if (typeof showChannelInfo === 'function') {
        opts.push(['Información', () => showChannelInfo(ch)]);
      }
      if (typeof showEditChannel === 'function') {
        opts.push(['Editar', () => showEditChannel(ch, [], () => paintUI(entry, corpus))]);
      }
      if (opts.length) sheet(channelName || ch?.name || 'Canal', opts);
    };

    /** Fila de cómic (principal) + subfilas de variantes WebP / IA */
    const paintComicRow = (host, it, queue) => {
      const block = el('div', 'sf-comic-block');
      const row = el('button', 'sf-comic-row');
      row.type = 'button';

      const cov = el('div', 'sf-comic-cover');
      try {
        if (typeof comicCover === 'function') appendCover(cov, comicCover(it.ch, it.f));
      } catch (_) {}

      const meta = el('div', 'sf-comic-meta');
      const titleLine = el('div', 'sf-comic-title');
      titleLine.append(el('b', '', it.title || ''));
      const badges = qualityBadges(it);
      if (badges) titleLine.append(badges);
      meta.append(titleLine);
      const sub = [it.seriesName || it.seriesLabel, it.channelName].filter(Boolean).join(' · ');
      if (sub) meta.append(el('small', '', sub));
      meta.append(el('small', 'sf-comic-bits', formatBytes(it.size)));
      row.append(cov, meta);

      row.onclick = (ev) => {
        try { ev.preventDefault(); } catch (_) {}
        openComic?.(it.ch, it.f, queue);
      };
      row.oncontextmenu = (ev) => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
        openComicMenu(it);
      };
      if (typeof bindLongPress === 'function') {
        bindLongPress(row, () => openComicMenu(it));
      }

      block.append(row);

      // Variantes anidadas
      const hasNested = it.hasWebpMid || it.hasWebpLow || it.hasAi;
      if (hasNested) {
        const nest = el('div', 'sf-nested');
        const addVariant = (label, file) => {
          if (!file) return;
          const vr = el('button', 'sf-variant-row');
          vr.type = 'button';
          vr.append(el('span', 'sf-variant-lab', label));
          vr.append(el('small', '', formatBytes(Number(file.size) || 0)));
          vr.onclick = (ev) => {
            try { ev.preventDefault(); } catch (_) {}
            openComic?.(it.ch, { ...it.f, ...file, id: file.id }, queue);
          };
          vr.oncontextmenu = (ev) => {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
            openComicMenu(it, { ...it.f, ...file, id: file.id });
          };
          if (typeof bindLongPress === 'function') {
            bindLongPress(vr, () => openComicMenu(it, { ...it.f, ...file, id: file.id }));
          }
          nest.append(vr);
        };
        if (it.variants?.mid) addVariant('WebP (Media)', it.variants.mid);
        if (it.variants?.low) addVariant('2400px · WebP (Baja)', it.variants.low);
        if (Array.isArray(it.aiList)) {
          for (const a of it.aiList) {
            let lab = 'IA';
            try { lab = 'IA · ' + ((aiLabel && aiLabel(sourceNameOf?.(a) || a.name)) || 'Mejora IA'); } catch (_) {}
            addVariant(lab, a);
          }
        }
        block.append(nest);
      }

      host.append(block);
    };

    const paintComicsList = (host, list) => {
      const queue = list.map((it) => it.f);
      for (const it of list) paintComicRow(host, it, queue);
    };

    /** Cabecera de serie con portada + tipo visual */
    const paintSeriesBlock = (host, ch, seriesLabel, seriesName, items) => {
      const block = el('div', 'sf-group sf-group-series');
      const head = el('button', 'sf-group-head sf-head-series');
      head.type = 'button';

      const cov = el('div', 'sf-group-cover sf-group-cover-series');
      try {
        if (typeof seriesCoverNode === 'function') {
          appendCover(cov, seriesCoverNode(ch, seriesLabel, items.map((x) => x.f), items.length));
        }
      } catch (_) {}

      const text = el('div', 'sf-group-text');
      const top = el('div', 'sf-group-kind', 'SERIE');
      text.append(top);
      text.append(el('b', '', seriesName || seriesLabel || 'Serie'));
      text.append(el('small', '',
        items.length + (items.length === 1 ? ' cómic' : ' cómics')
        + (items[0]?.channelName ? ' · ' + items[0].channelName : '')));

      const arrow = el('span', 'sf-group-arrow', '▶');
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
        openSeriesMenu(ch, seriesLabel, seriesName, items);
      };
      if (typeof bindLongPress === 'function') {
        bindLongPress(head, () => openSeriesMenu(ch, seriesLabel, seriesName, items));
      }

      block.append(head, body);
      host.append(block);
    };

    /** Canal: abre → series (no cómics sueltos como series falsas) */
    const paintChannelBlock = (host, ch, channelName, items) => {
      const block = el('div', 'sf-group sf-group-channel');
      const head = el('button', 'sf-group-head sf-head-channel');
      head.type = 'button';

      const cov = el('div', 'sf-group-cover sf-group-cover-channel');
      try {
        if (typeof channelCoverNode === 'function') {
          appendCover(cov, channelCoverNode(ch, items.map((x) => x.f)));
        }
      } catch (_) {}

      // Contar solo series reales (con seriesLabel) y cómics lógicos (ya colapsados)
      const seriesMap = new Map();
      let loose = 0;
      for (const it of items) {
        if (it.seriesLabel) {
          if (!seriesMap.has(it.seriesLabel)) seriesMap.set(it.seriesLabel, []);
          seriesMap.get(it.seriesLabel).push(it);
        } else {
          loose++;
        }
      }
      const nSeries = seriesMap.size;
      const nComics = items.length; // ya son lógicos, sin WebP/IA duplicados

      const text = el('div', 'sf-group-text');
      text.append(el('div', 'sf-group-kind', 'CANAL'));
      text.append(el('b', '', channelName || ch?.name || 'Canal'));
      const parts = [];
      if (nSeries) parts.push(nSeries + (nSeries === 1 ? ' serie' : ' series'));
      if (loose) parts.push(loose + (loose === 1 ? ' cómic suelto' : ' cómics sueltos'));
      parts.push(nComics + (nComics === 1 ? ' cómic' : ' cómics'));
      if (items[0]?.editorialName) parts.push(items[0].editorialName);
      text.append(el('small', '', parts.join(' · ')));

      const arrow = el('span', 'sf-group-arrow', '▶');
      head.append(cov, text, arrow);

      const body = el('div', 'sf-group-body');
      body.hidden = true;

      const fill = () => {
        if (body.dataset.filled) return;
        body.dataset.filled = '1';
        const nat = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
        // Series primero
        const seriesList = [...seriesMap.entries()]
          .map(([label, its]) => ({
            seriesLabel: label,
            seriesName: its[0]?.seriesName || label,
            items: its,
          }))
          .sort((a, b) => nat(a.seriesName, b.seriesName));
        for (const g of seriesList) {
          paintSeriesBlock(body, ch, g.seriesLabel, g.seriesName, g.items);
        }
        // Cómics sin serie
        const solos = items.filter((it) => !it.seriesLabel);
        if (solos.length) paintComicsList(body, solos);
      };

      head.onclick = (ev) => {
        try { ev.preventDefault(); } catch (_) {}
        body.hidden = !body.hidden;
        arrow.textContent = body.hidden ? '▶' : '▼';
        if (!body.hidden) fill();
      };
      head.oncontextmenu = (ev) => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
        openChannelMenu(ch, channelName);
      };
      if (typeof bindLongPress === 'function') {
        bindLongPress(head, () => openChannelMenu(ch, channelName));
      }

      block.append(head, body);
      host.append(block);
    };

    const paintGroupedSeries = (host, list) => {
      const map = new Map();
      for (const it of list) {
        // Solo agrupar si hay seriesLabel real
        const key = it.seriesLabel
          ? (it.channelId + '::' + it.seriesLabel)
          : null;
        if (!key) continue;
        if (!map.has(key)) {
          map.set(key, {
            ch: it.ch,
            seriesLabel: it.seriesLabel,
            seriesName: it.seriesName || it.seriesLabel,
            items: [],
          });
        }
        map.get(key).items.push(it);
      }
      const nat = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
      const groups = [...map.values()].sort((a, b) => nat(a.seriesName, b.seriesName));
      for (const g of groups) paintSeriesBlock(host, g.ch, g.seriesLabel, g.seriesName, g.items);
      // Cómics sin serie al final
      const solos = list.filter((it) => !it.seriesLabel);
      if (solos.length) {
        const box = el('div', 'sf-group sf-group-loose');
        box.append(el('div', 'sf-loose-title', 'Sin serie'));
        paintComicsList(box, solos);
        host.append(box);
      }
      if (!groups.length && !solos.length) {
        host.append(el('p', 'sf-empty', 'Sin series en estos resultados.'));
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

      const panel = el('div', 'sf-panel');
      const grid = el('div', 'sf-fgrid');

      grid.append(mkFilterRow('Editorial', filterState.editorial,
        [['', 'Todas'], ...optsSel.editorials.map(([k, v]) => [k, v])],
        (v) => {
          filterState.editorial = v;
          filterState.channel = '';
          filterState.series = '';
          paint();
        }));

      // Canal: solo visible si hay editorial elegida (como Ficha incompleta → Campo vacío)
      if (filterState.editorial) {
        grid.append(mkFilterRow('Canal', filterState.channel,
          [['', 'Todos'], ...optsSel.channels.map(([k, v]) => [k, v])],
          (v) => {
            filterState.channel = v;
            filterState.series = '';
            paint();
          }));
      }

      // Serie: solo visible si hay canal elegido
      if (filterState.channel) {
        grid.append(mkFilterRow('Serie', filterState.series,
          [['', 'Todas'], ...optsSel.series.map(([k, v]) => [k, v])],
          (v) => { filterState.series = v; paint(); }));
      }

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
      ], (v) => {
        filterState.ficha = v;
        if (v !== 'incomplete') filterState.fichaField = '';
        paint();
      }));
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
        ? 'Hay datos en caché. «Búsqueda rápida» los reutiliza al instante; «Actualizar y buscar» vuelve a leer Telegram.'
        : 'Elige cómo cargar los datos de la biblioteca.'
    ));
    const act = el('div', 'edit-actions');
    act.style.flexDirection = 'column';
    act.style.gap = '8px';
    const full = el('button', 'btn edit-save', 'Actualizar y buscar');
    full.type = 'button';
    full.onclick = () => {
      frame.remove();
      corpusCache = null;
      renderFiltersView({ forceFetch: true });
    };
    const quick = el('button', 'btn', 'Búsqueda rápida');
    quick.type = 'button';
    quick.onclick = () => {
      frame.remove();
      renderFiltersView({ forceFetch: false });
    };
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
    invalidateCorpus: () => { corpusCache = null; },
  };
}
