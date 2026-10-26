import {
  isComicRead as isComicReadFn,
  readProgress as readProgressFn,
  getContinueList as getContinueListFn,
  markComicRead as markComicReadFn,
  markComicUnread as markComicUnreadFn,
  markSeriesRead as markSeriesReadFn,
  markSeriesUnread as markSeriesUnreadFn,
  getPageIndex as getPageIndexFn,
  getPagesTotal as getPagesTotalFn,
  listUnfinishedProgress as listUnfinishedProgressFn,
} from './progress.js';

/**
 * Vistas de navegación: home (editoriales), canales, series, archivos.
 */
export function createViews(d) {
  const {
    el, app, top, h1, actions, search,
    locks, ART,
    groupDisplayName, channelDisplayName, seriesDisplayName, comicDisplayName,
    comicDisplay, comicSourceName, issueLabel, groupSeries, seriesOverrideFor,
    clean, stripExt, sizeLabel, formatBytes,
    art, groupCoverNode, channelCoverNode, seriesCoverNode,
    getCover, comicCover, io,
    go, show, stack,
    sheet, bindLongPress, grid,
    showGroupInfo, showEditGroup, showChannelInfo, showEditChannel,
    showSeriesInfo, showEditSeries, showSeriesCvFillForm, comicNeedsCvFill, showComicInfo, showEditComicTitle,
    showCoverFitEditor, showPickCoverFromComic, getCoverFit,
    ungroupMap, setUngroupMode, getComicSeriesOverride,
    firstAvailableCover, kv, natural,
    pref, setPref,
    appAlert, appConfirm, appPrompt,
    parseComicName, issueDisplay,
    parseComicCaption,
    buildSearchIndex, filterSearchIndex,
  } = d;
  const openComic = (...a) => d.openComic(...a);

  // ---- Ordenación de listados (editorial / canal / serie) ----
  const sortKey = (scope, id) => 'sort:' + scope + ':' + String(id || '');
  const getSortPref = (scope, id) => {
    const defaultMode = scope === 'authorSeries' ? 'date' : 'name';
    try {
      const raw = localStorage.getItem(sortKey(scope, id));
      if (!raw) return { mode: defaultMode };
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return { mode: defaultMode };
      const mode = ['name', 'date', 'manual'].includes(o.mode) ? o.mode : defaultMode;
      return { mode, order: Array.isArray(o.order) ? o.order.map(String) : [] };
    } catch {
      return { mode: defaultMode };
    }
  };
  const setSortPref = (scope, id, prefObj) => {
    try {
      localStorage.setItem(sortKey(scope, id), JSON.stringify(prefObj));
    } catch (_) {}
  };
    const captionDateOf = (f) => {
    try {
      const rawCap = String(f?.caption || '').trim();
      if (!rawCap) return null;
      const cap = typeof parseComicCaption === 'function' ? parseComicCaption(rawCap) : null;
      let raw = String(cap?.date || '').trim();
      // Fallback: línea "Fecha..." si el parser no la mapeó
      if (!raw) {
        const lm = rawCap.match(/(?:^|\n)\s*Fecha(?:\s+de\s+publicaci[oó]n)?\s*[:：]\s*([^\n]+)/i);
        if (lm) raw = lm[1].trim();
      }
      if (!raw) return null;
      // MM/AAAA o MM-AAAA
      let m = raw.match(/^(\d{1,2})\s*[\/\-\.\s]\s*(\d{4})/);
      if (m) return Number(m[2]) * 100 + Number(m[1]);
      // AAAA-MM / AAAA/MM
      m = raw.match(/^(\d{4})\s*[\/\-\.\s]\s*(\d{1,2})/);
      if (m) return Number(m[1]) * 100 + Number(m[2]);
      // Solo año
      m = raw.match(/^(\d{4})\b/);
      if (m) return Number(m[1]) * 100;
      // "Month YYYY" inglés básico
      m = raw.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})/i);
      if (m) {
        const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
        const mo = months[m[1].slice(0, 3).toLowerCase()] || 1;
        return Number(m[2]) * 100 + mo;
      }
      const t = Date.parse(raw);
      if (Number.isFinite(t)) {
        const dt = new Date(t);
        return dt.getFullYear() * 100 + (dt.getMonth() + 1);
      }
    } catch (_) {}
    return null;
  };

  /** Fecha del "primer" cómic de una serie = el de menor número (#). */
  const seriesFirstComicDate = (files, ch) => {
    const list = Array.isArray(files) ? files.slice() : [];
    if (!list.length) return null;
    const numOf = (f) => {
      try {
        const src = (typeof comicSourceName === 'function' ? comicSourceName(f) : null) || f?.name || '';
        const p = typeof parseComicName === 'function' ? parseComicName(src, ch?.name) : null;
        if (p?.number != null && p.number !== '') {
          const n = parseFloat(String(p.number).replace(/[^0-9.]/g, ''));
          if (Number.isFinite(n)) return n;
        }
        const m = String(src).match(/#\s*([0-9]+(?:\.[0-9]+)?)/);
        if (m) return parseFloat(m[1]);
      } catch (_) {}
      return 1e12;
    };
    list.sort((a, b) => {
      const na = numOf(a), nb = numOf(b);
      if (na !== nb) return na - nb;
      return natural(String(a?.name || ''), String(b?.name || ''));
    });
    // Primer cómic con fecha; si ninguno, null
    for (const f of list) {
      const d = captionDateOf(f);
      if (d != null) return d;
    }
    return null;
  };

const applySortList = (items, prefObj, getId, getLabel, getDate) => {
    const list = (items || []).slice();
    const mode = prefObj?.mode || 'name';
    if (mode === 'manual' && prefObj.order?.length) {
      const pos = new Map(prefObj.order.map((id, i) => [String(id), i]));
      list.sort((a, b) => {
        const ia = pos.has(String(getId(a))) ? pos.get(String(getId(a))) : 1e9;
        const ib = pos.has(String(getId(b))) ? pos.get(String(getId(b))) : 1e9;
        if (ia !== ib) return ia - ib;
        return natural(String(getLabel(a)), String(getLabel(b)));
      });
      return list;
    }
    if (mode === 'date') {
      list.sort((a, b) => {
        const da = getDate(a);
        const db = getDate(b);
        if (da != null && db != null && da !== db) return da - db;
        if (da != null && db == null) return -1;
        if (da == null && db != null) return 1;
        return natural(String(getLabel(a)), String(getLabel(b)));
      });
      return list;
    }
    list.sort((a, b) => natural(String(getLabel(a)), String(getLabel(b))));
    return list;
  };
  /** Ordena los cómics de una serie igual que la vista de la serie (nombre / fecha / manual).
   *  También lo usa el visor (resolveQueue) cuando abre sin cola, p. ej. desde "Seguir leyendo". */
  const sortSeriesFiles = (ch, s, fs) => {
    const items = (fs || []).map((f) => {
      let label = '';
      try {
        const p = parseComicName(comicSourceName(f), ch.name);
        const baseLabel = (p && String(p.series || '').toLowerCase() === String(s).toLowerCase())
          ? issueDisplay(p)
          : issueLabel(s, f, ch.name);
        label = comicDisplayName(ch, f, baseLabel);
      } catch (_) { label = String(f?.name || ''); }
      return { _f: f, _sortId: String(f.id), _sortDate: captionDateOf(f), label };
    });
    return applySortList(items, getSortPref('series', String(ch.id) + ':' + String(s)),
      (it) => it._sortId, (it) => it.label || '', (it) => it._sortDate ?? null).map((it) => it._f);
  };
  try { globalThis.__tgSortSeriesFiles = sortSeriesFiles; } catch (_) {}
  const SORT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4v16"/><path d="M5 17l3 3 3-3"/><path d="M16 20V4"/><path d="M13 7l3-3 3 3"/></svg>`;

  function showSortFrame({ title, scope, id, items, getId, getLabel, getDate, onDone }) {
    document.querySelector('.info-frame.sort-frame')?.remove();
    const cur = getSortPref(scope, id);
    const frame = el('div', 'info-frame sort-frame');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Ordenar'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint', title || 'Elige cómo ordenar este listado. Se guarda en este dispositivo.'));

    const mkRadio = (mode, labelText) => {
      const row = el('label', 'sort-opt');
      const inp = el('input');
      inp.type = 'radio';
      inp.name = 'sort-mode';
      inp.value = mode;
      if (cur.mode === mode) inp.checked = true;
      row.append(inp, document.createTextNode(' ' + labelText));
      body.append(row);
      return inp;
    };
    const rName = mkRadio('name', scope === 'authorSeries' ? 'Por nombre' : 'Por nombre (predeterminado)');
    const rDate = mkRadio('date', scope === 'authorSeries' ? 'Por fecha (caption Telegram, predeterminado)' : 'Por fecha (caption Telegram)');
    const rMan = mkRadio('manual', 'Manual (arrastrar)');

    const manualHost = el('div');
    manualHost.hidden = cur.mode !== 'manual';
    const ul = el('ul', 'sort-manual-list');
    const base = applySortList(items, cur.mode === 'manual' ? cur : { mode: 'name' }, getId, getLabel, getDate);
    const stateOrder = base.map((it) => String(getId(it)));
    const labelOf = (sid) => {
      const it = (items || []).find((x) => String(getId(x)) === String(sid));
      return it ? getLabel(it) : sid;
    };
    const moveItem = (sid, dir) => {
      const ids = stateOrder.slice();
      const from = ids.indexOf(String(sid));
      if (from < 0) return;
      const to = from + dir;
      if (to < 0 || to >= ids.length) return;
      const tmp = ids[from];
      ids[from] = ids[to];
      ids[to] = tmp;
      stateOrder.length = 0;
      stateOrder.push(...ids);
      paintManual();
    };
    const paintManual = () => {
      ul.replaceChildren();
      stateOrder.forEach((sid, idx) => {
        const li = el('li');
        li.dataset.id = sid;
        const name = el('span', 'sort-manual-name', labelOf(sid));
        const btns = el('div', 'sort-manual-btns');
        const up = el('button', 'btn sort-move', '↑');
        up.type = 'button';
        up.disabled = idx === 0;
        up.setAttribute('aria-label', 'Subir');
        up.onclick = (ev) => { try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {} moveItem(sid, -1); };
        const down = el('button', 'btn sort-move', '↓');
        down.type = 'button';
        down.disabled = idx === stateOrder.length - 1;
        down.setAttribute('aria-label', 'Bajar');
        down.onclick = (ev) => { try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {} moveItem(sid, 1); };
        btns.append(up, down);
        li.append(name, btns);
        ul.append(li);
      });
    };
    paintManual();
    manualHost.append(el('p', 'cover-pick-hint', 'Usa ↑ / ↓ para reordenar:'), ul);
    body.append(manualHost);

        const syncManualVis = () => { manualHost.hidden = !rMan.checked; };
    rName.onchange = rDate.onchange = rMan.onchange = syncManualVis;

    const act = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => frame.remove();
    const save = el('button', 'btn edit-save', 'Aplicar');
    save.onclick = () => {
      let mode = 'name';
      if (rDate.checked) mode = 'date';
      else if (rMan.checked) mode = 'manual';
      const prefObj = { mode, order: mode === 'manual' ? stateOrder.slice() : [] };
      setSortPref(scope, id, prefObj);
      frame.remove();
      try { onDone?.(prefObj); } catch (_) {}
    };
    act.append(cancel, save);
    body.append(act);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }

  function mountSortButton(cfg) {
    hideGroupButton(); // solo la vista de autor lo vuelve a mostrar
    let btn = actions?.querySelector?.('.sort-btn');
    if (!btn) {
      btn = el('button', 'btn sort-btn');
      btn.type = 'button';
      btn.title = 'Ordenar';
      btn.setAttribute('aria-label', 'Ordenar listado');
      btn.innerHTML = SORT_ICON;
      const menu = actions?.querySelector?.('.menu-btn');
      if (menu) actions.insertBefore(btn, menu);
      else if (actions) actions.append(btn);
    }
    btn.hidden = false;
    btn.onclick = (ev) => {
      try { ev.stopPropagation(); } catch (_) {}
      const items = typeof cfg.getItems === 'function' ? cfg.getItems() : (cfg.items || []);
      showSortFrame({
        title: cfg.title,
        scope: cfg.scope,
        id: cfg.id,
        items,
        getId: cfg.getId,
        getLabel: cfg.getLabel,
        getDate: cfg.getDate,
        onDone: cfg.onDone,
      });
    };
    return btn;
  }
  function clearSortButton() {
    try {
      const btn = actions?.querySelector?.('.sort-btn');
      if (btn) btn.hidden = true;
    } catch (_) {}
    hideGroupButton();
  }

  // Botón "Agrupar por series" (solo en la vista de un autor), a la izquierda del de ordenar
  const GROUP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>`;
  function hideGroupButton() {
    try {
      const gb = actions?.querySelector?.('.group-btn');
      if (gb) gb.hidden = true;
    } catch (_) {}
  }
  function mountGroupButton({ active, onToggle }) {
    let btn = actions?.querySelector?.('.group-btn');
    if (!btn) {
      btn = el('button', 'btn group-btn');
      btn.type = 'button';
      btn.innerHTML = GROUP_ICON;
      const sortBtn = actions?.querySelector?.('.sort-btn');
      const menu = actions?.querySelector?.('.menu-btn');
      if (sortBtn) actions.insertBefore(btn, sortBtn);
      else if (menu) actions.insertBefore(btn, menu);
      else if (actions) actions.append(btn);
    }
    btn.hidden = false;
    btn.classList.toggle('on', !!active);
    btn.title = active ? 'Ver cómics sueltos' : 'Agrupar por series';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.onclick = (ev) => {
      try { ev.stopPropagation(); } catch (_) {}
      try { onToggle?.(); } catch (e) { console.warn('[group]', e); }
    };
    return btn;
  }


  const setLastScrollY = (y) => {
    if (typeof d.setLastScrollY === 'function') d.setLastScrollY(y);
    else if (typeof d.lastScrollY !== 'undefined') { try { d.lastScrollY = y; } catch (_) {} }
  };
  // Dependencias que deben resolverse en tiempo de ejecución (no snapshot)
  const alive = (e) => {
    const st = d.stack;
    return Array.isArray(st) && st.length && st[st.length - 1] === e;
  };
  const fetchFiles = async (...a) => {
    if (typeof d.fetchFiles !== 'function') return [];
    return d.fetchFiles(...a);
  };
  const mapLimit = async (...a) => {
    if (typeof d.mapLimit === 'function') return d.mapLimit(...a);
    // fallback secuencial
    const [items, , fn] = a;
    const out = [];
    for (const it of (items || [])) out.push(await fn(it));
    return out;
  };
  const titleEl = d.titleEl || d.h1 || null;
  const seriesBase = (...a) => (typeof d.seriesBase === 'function' ? d.seriesBase(...a) : '');
  const setBlobImg = (...a) => (typeof d.setBlobImg === 'function' ? d.setBlobImg(...a) : null);

  // Progreso / lectura: import directo de progress.js (no depende de d)
  const isComicRead = (chId, msgId) => {
    try { return !!(isComicReadFn(chId, msgId)); } catch { return false; }
  };
  const readProgress = (chId, msgId) => {
    try { return readProgressFn(chId, msgId); } catch { return null; }
  };
  const getContinueList = () => {
    try { return getContinueListFn() || []; } catch { return []; }
  };
  const markComicRead = (...a) => markComicReadFn(...a);
  const markComicUnread = (...a) => markComicUnreadFn(...a);
  const markSeriesRead = (...a) => markSeriesReadFn(...a);
  const markSeriesUnread = (...a) => markSeriesUnreadFn(...a);
  const getPageIndex = (...a) => { try { return getPageIndexFn(...a); } catch { return 0; } };
  const getPagesTotal = (...a) => { try { return getPagesTotalFn(...a); } catch { return 0; } };
  // listUnfinishedProgress: preferir import; d por si acaso
  const listUnfinishedProgress = () => {
    try {
      if (typeof listUnfinishedProgressFn === 'function') return listUnfinishedProgressFn() || [];
      if (typeof d.listUnfinishedProgress === 'function') return d.listUnfinishedProgress() || [];
    } catch (_) {}
    return [];
  };

  const msg = (...a) => (typeof d.msg === 'function' ? d.msg(...a) : undefined);
  const libNow = () => {
    const L = typeof d.LIB === 'function' ? d.LIB() : d.LIB;
    return Array.isArray(L) ? L : [];
  };
  const syncedNow = () => !!(typeof d.synced === 'function' ? d.synced() : d.synced);
  const repackTool = new Proxy({}, {
    get(_t, prop) {
      const rt = typeof d.repackTool === 'function' ? d.repackTool() : d.repackTool;
      if (!rt) return undefined;
      const val = rt[prop];
      return typeof val === 'function' ? val.bind(rt) : val;
    },
  });


  function comicDownloadName(f) {
    let name = '';
    try {
      const cap = String(f?.caption || '');
      const m = cap.match(/^\s*Nombre de archivo\s*:\s*(.+)$/im);
      if (m) name = m[1].trim();
    } catch (_) {}
    if (!name) name = String(f?.name || 'comic.cbz');
    name = name.replace(/[\/\\?%*:|"<>]/g, '_').trim() || 'comic.cbz';
    if (!/\.cb[zr]$/i.test(name)) {
      const ext = /\.cbr$/i.test(f?.name || '') ? '.cbr' : '.cbz';
      name += ext;
    }
    return name;
  }

  async function downloadComicFile(ch, f) {
    if (typeof d.downloadComic === 'function') {
      return d.downloadComic(ch, f);
    }
    const getMsg = d.getMsg;
    const client = typeof d.client === 'function' ? d.client() : d.client;
    const readyP = typeof d.ready === 'function' ? d.ready() : d.ready;
    if (!getMsg || !client) {
      await appAlert('Descarga no disponible en este contexto.');
      return;
    }
    const outName = comicDownloadName(f);

    // 1) Pedir carpeta YA (gesto del usuario). Si se descarga antes, el navegador
    //    bloquea showDirectoryPicker y cae al guardado silencioso de Descargas.
    let dirHandle = null;
    const canPickDir = typeof window.showDirectoryPicker === 'function'
      && !( /iPhone|iPad|iPod/i.test(navigator.userAgent || '') );
    if (canPickDir) {
      try {
        dirHandle = await window.showDirectoryPicker({
          mode: 'readwrite',
          id: 'tgcomic-downloads',
          startIn: 'downloads',
        });
      } catch (e) {
        if (e?.name === 'AbortError') return; // canceló
        console.warn('[download] showDirectoryPicker', e);
        // Si falla el picker, preguntamos si continuar a Descargas del navegador
        const ok = await appConfirm(
          'No se pudo abrir el selector de carpeta del sistema.\n¿Guardar en la carpeta Descargas del navegador?',
          'Descarga'
        );
        if (!ok) return;
      }
    }

    let statusFrame = null;
    const closeStatus = () => { try { statusFrame?.remove(); } catch (_) {} statusFrame = null; };
    const setStatus = (t) => {
      try {
        if (!statusFrame) {
          statusFrame = el('div', 'info-frame');
          const box = el('div', 'info-box');
          const head = el('div', 'info-head');
          head.append(el('span', '', 'Descarga'));
          const body = el('div', 'info-body');
          body.append(el('p', 'cover-pick-hint dl-status', t));
          box.append(head, body);
          statusFrame.append(box);
          document.body.append(statusFrame);
        } else {
          const p = statusFrame.querySelector('.dl-status');
          if (p) p.textContent = t;
        }
      } catch (_) {}
    };

    try {
      if (readyP && typeof readyP.then === 'function') await readyP;
      setStatus('Obteniendo archivo de Telegram…');
      const m = await getMsg(ch, f);
      if (!m?.media && !m?.document) throw new Error('Mensaje sin archivo');
      const size = Number(f?.size || (m.document?.size != null ? m.document.size.toString() : 0) || 0);
      setStatus(size ? 'Descargando… 0%' : 'Descargando…');
      const buf = await client.downloadMedia(m.media || m, {
        workers: 4,
        progressCallback: (got) => {
          const n = Number(got?.toString?.() ?? got);
          if (size > 0 && n >= 0) setStatus('Descargando… ' + Math.min(100, Math.round((n / size) * 100)) + '%');
        },
      });
      if (!buf) throw new Error('Descarga vacía');
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      const blob = new Blob([u8], { type: 'application/octet-stream' });

      if (dirHandle) {
        setStatus('Guardando en la carpeta elegida…');
        const fh = await dirHandle.getFileHandle(outName, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        closeStatus();
        await appAlert('Guardado en la carpeta elegida:\n' + outName);
        return;
      }

      // Sin File System Access (Safari/Firefox/iOS): descarga del navegador
      setStatus('Guardando…');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outName;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (_) {} }, 2000);
      closeStatus();
    } catch (e) {
      closeStatus();
      await appAlert('No se pudo descargar: ' + (e?.message || e));
    }
  }

  /** Submenú de serie: Información · Editar TODA la serie · Marcar · Desagrupar/Agrupar · Añadir versión WebP (+ Bloquear aparte) */
  function seriesSheetOpts(ch, seriesLabel, fs, redraw, { groupState = 'grouped', afterBack = null } = {}) {
    const back = afterBack || redraw;
    const files = fs || [];
    const opts = [
      ['Información', () => showSeriesInfo(ch, seriesLabel, files)],
      ['Editar', () => {
        const openRoot = () => sheet(seriesDisplayName(ch, seriesLabel), seriesSheetOpts(ch, seriesLabel, files, redraw, { groupState, afterBack }));
        const editOpts = [
          ['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, files, redraw,
            () => sheet('Editar', editOpts, { cancelLabel: 'Volver', onCancel: openRoot }))],
          ['Recargar fichas Telegram (Cómic Vine)', () => {
            if (typeof showSeriesCvFillForm === 'function') {
              showSeriesCvFillForm(ch, seriesLabel, files, { overwrite: true,
                onBack: () => sheet('Editar', editOpts, { cancelLabel: 'Volver', onCancel: openRoot }) });
            } else {
              appAlert('Función no disponible');
            }
          }],
        ];
        sheet('Editar', editOpts, { cancelLabel: 'Volver', onCancel: openRoot });
      }],
      ['Marcar', () => {
        const openRoot = () => sheet(seriesDisplayName(ch, seriesLabel), seriesSheetOpts(ch, seriesLabel, files, redraw, { groupState, afterBack }));
        sheet('Marcar', [
          ['Marcar toda la serie como leída', () => markSeriesRead(ch, files, redraw)],
          ['Marcar toda la serie NO como leída', () => markSeriesUnread(ch, files, redraw)],
        ], { cancelLabel: 'Volver', onCancel: openRoot });
      }],
    ];
    if (groupState === 'short' || groupState === 'full') {
      opts.push(['Agrupar', () => setUngroupMode(ch, seriesLabel, null, back)]);
    } else if (files.length > 1) {
      opts.push(['Desagrupar', () => {
        const openRoot = () => sheet(seriesDisplayName(ch, seriesLabel), seriesSheetOpts(ch, seriesLabel, files, redraw, { groupState, afterBack }));
        sheet('Desagrupar', [
          ['Desagrupar con Número y Títulos', () => setUngroupMode(ch, seriesLabel, 'short', back)],
          ['Desagrupar con Nombre Serie, Número y Títulos', () => setUngroupMode(ch, seriesLabel, 'full', back)],
        ], { cancelLabel: 'Volver', onCancel: openRoot });
      }]);
    }
    opts.push(['Añadir versión WebP', () => {
      try { repackTool?.offerWebpVersionSeries?.(ch, seriesLabel, files); }
      catch (e) { appAlert(e?.message || e); }
    }]);
    return opts;
  }

  function comicSheetOpts(ch, f, label, redraw, ctx = {}) {
    const seriesLabel = ctx.seriesLabel || null;
    const seriesFiles = ctx.seriesFiles || null;
    const groupState = ctx.groupState || null;
    const afterBack = ctx.afterDesagrupar;
    const openRoot = () => sheet(label, comicSheetOpts(ch, f, label, redraw, ctx).concat(lockToggleOpts('comic', { ch, f }, label, redraw)));

    const opts = [
      ['Información', () => showComicInfo(ch, f, label)],
      ['Editar', () => {
        const openEditMenu = () => {
          const editOpts = [
            ['Editar datos del cómic', () => showEditComicTitle(ch, f, label, redraw)],
          ];
          if (seriesLabel) {
            editOpts.push(['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, seriesFiles || [f], redraw, openEditMenu)]);
          }
          editOpts.push(['Recargar fichas Telegram (Cómic Vine)', async () => {
            if (typeof showSeriesCvFillForm !== 'function') return appAlert('Función no disponible');
            const files = (await kv.get('f:' + ch.id)) || seriesFiles || [f];
            const groups = groupSeries(files.length ? files : [f], ch.name, seriesOverrideFor?.(ch));
            const group = groups.find((g) => g.files.some((member) => String(member.id) === String(f.id)));
            showSeriesCvFillForm(ch, group?.label || seriesLabel || label, group?.files || seriesFiles || [f], {
              overwrite: true, onBack: openEditMenu,
            });
          }]);
          editOpts.push(['Adaptar portada', () => {
            if (typeof showCoverFitEditor === 'function') {
              showCoverFitEditor(ch, f, () => { try { redraw?.(); } catch (_) {} openEditMenu(); });
            } else appAlert('Adaptar portada no disponible');
          }]);
          editOpts.push(['Elegir portada dentro del cómic', () => {
            if (typeof showPickCoverFromComic === 'function') {
              showPickCoverFromComic(ch, f, () => { try { redraw?.(); } catch (_) {} openEditMenu(); });
            } else appAlert('Elegir portada no disponible');
          }]);
          sheet('Editar', editOpts, { cancelLabel: 'Volver', onCancel: () => sheet(label, comicSheetOpts(ch, f, label, redraw, ctx).concat(lockToggleOpts('comic', { ch, f }, label, redraw))) });
        };
        openEditMenu();
      }],
      ['Marcar', () => {
        const unread = !isComicRead(ch.id, f.id);
        const markOpts = [
          unread
            ? ['Marcar CÓMIC como leído', () => markComicRead(ch, f, redraw)]
            : ['Marcar CÓMIC como NO leído', () => markComicUnread(ch, f, redraw)],
        ];
        if (seriesFiles && seriesFiles.length > 1) {
          const anyUnread = seriesFiles.some((x) => !isComicRead(ch.id, x.id));
          markOpts.push(anyUnread
            ? ['Marcar SERIE como leída', () => markSeriesRead(ch, seriesFiles, redraw)]
            : ['Marcar SERIE como NO leída', () => markSeriesUnread(ch, seriesFiles, redraw)]);
        }
        sheet('Marcar', markOpts, { cancelLabel: 'Volver', onCancel: () => sheet(label, comicSheetOpts(ch, f, label, redraw, ctx).concat(lockToggleOpts('comic', { ch, f }, label, redraw))) });
      }],
    ];

    if (groupState === 'grouped' && seriesFiles && seriesFiles.length > 1) {
      opts.push(['Desagrupar', () => {
        sheet('Desagrupar', [
          ['Desagrupar con Número y Títulos', () => setUngroupMode(ch, seriesLabel, 'short', afterBack || redraw)],
          ['Desagrupar con Nombre Serie, Número y Títulos', () => setUngroupMode(ch, seriesLabel, 'full', afterBack || redraw)],
        ], { cancelLabel: 'Volver', onCancel: openRoot });
      }]);
    } else if (groupState === 'short' || groupState === 'full') {
      // Serie desagrupada: la opción pasa a "Agrupar"
      opts.push(['Agrupar', () => setUngroupMode(ch, seriesLabel, null, afterBack || redraw)]);
    }

    opts.push(['Añadir versión WebP', () => {
      try { repackTool?.offerWebpVersion?.(ch, f); }
      catch (e) { appAlert(e?.message || e); }
    }]);
    opts.push(['Descargar cómic', () => { downloadComicFile(ch, f); }]);
    return opts;
  }

function cardNode(i) {
  const c = el('div', 'card');
  if (i.hiddenMeta) c.classList.add('card-locked');
  const hit = el('button', 'hit');
  const cv = i.cover();
  // La portada lleva siempre la clase de su tipo (comic/series/channel), también si está bloqueada
  if (i.kind && cv && cv.classList) {
    cv.classList.remove('cover-comic', 'cover-series', 'cover-channel');
    cv.classList.add('cover-' + i.kind);
  }
  hit.append(cv);
  hit.onclick = i.go;
  if (i.longPress) bindLongPress(hit, i.longPress);
  c.append(hit);
  // Contenido bloqueado: solo portada (Blur_candado), sin nombre ni subtítulo
  if (i.hiddenMeta) {
    hit.setAttribute('aria-label', 'Contenido bloqueado');
    return c;
  }
  const name = el('div', 'name');
  const t = el('b', '', i.label);
  if (i.menu) {
    t.classList.add('has-menu');
    t.onclick = (ev) => { ev.stopPropagation(); i.menu(); };
    t.title = 'Opciones';
    t.setAttribute('role', 'button');
  } else t.onclick = i.go;
  if (i.longPress) bindLongPress(t, i.longPress);
  name.append(t);
  // Título + info juntos en un bloque de alto fijo: la info va pegada al título, las filas siguen uniformes
  const metaBox = el('div', 'meta');
  metaBox.append(name);
  if (i.sub) metaBox.append(el('small', '', i.sub));
  c.append(metaBox);
  return c;
}

/** Opciones Bloquear/Desbloquear para submenús */
function lockToggleOpts(kind, ref, label, redraw) {
  if (!locks.canUseLocks()) return [];
  const marked =
    kind === 'group' ? locks.isGroupMarked(ref)
    : kind === 'channel' ? locks.isChannelMarked(ref)
    : kind === 'series' ? locks.isSeriesMarked(ref.ch, ref.seriesLabel)
    : kind === 'comic' ? locks.isComicMarked(ref.ch, ref.f)
    : false;
  if (marked) {
    return [['Desbloquear', async () => {
      if (!locks.isSessionUnlocked()) {
        const pw = await appPrompt('Contraseña de sincronización', 'Desbloquear', '', 'password');
        if (pw == null) return;
        if (!(await locks.unlockSession(pw))) return appAlert('Contraseña incorrecta', 'Desbloquear');
      }
      if (kind === 'group') locks.setGroupLocked(ref, false);
      else if (kind === 'channel') locks.setChannelLocked(ref, false);
      else if (kind === 'series') locks.setSeriesLocked(ref.ch, ref.seriesLabel, false);
      else if (kind === 'comic') locks.setComicLocked(ref.ch, ref.f, false);
      redraw?.();
    }]];
  }
  return [['Bloquear', async () => {
    if (!locks.isSessionUnlocked()) {
      const pw = await appPrompt('Contraseña de sincronización', 'Bloquear', '', 'password');
      if (pw == null) return;
      if (!(await locks.unlockSession(pw))) return appAlert('Contraseña incorrecta', 'Bloquear');
    }
    if (kind === 'group') locks.setGroupLocked(ref, true);
    else if (kind === 'channel') locks.setChannelLocked(ref, true);
    else if (kind === 'series') locks.setSeriesLocked(ref.ch, ref.seriesLabel, true);
    else if (kind === 'comic') locks.setComicLocked(ref.ch, ref.f, true);
    redraw?.();
  }]];
}

function groupsView() {
  clearSortButton();
  const LIB = libNow();
  const synced = syncedNow();
  if (!LIB.length) return msg(synced ? 'No se encontraron canales ...::Comics::tgstorage.' : 'Conectando…');

  let searchIndex = null;
  let searchIndexPromise = null;
  const ensureIndex = () => {
    if (searchIndex) return Promise.resolve(searchIndex);
    if (searchIndexPromise) return searchIndexPromise;
    searchIndexPromise = (buildSearchIndex || d.buildSearchIndex)({
      LIB: libNow(),
      getFiles: async (ch) => (await kv.get('f:' + ch.id)) || [],
      groupDisplayName,
      channelDisplayName,
      seriesDisplayName,
      groupSeries,
      seriesOverrideFor,
      comicDisplay,
      comicDisplayName,
      openSeries: (ch, seriesLabel, fs) => seriesView(ch, seriesLabel, fs),
      openComic: (ch, f) => openComic(ch, f),
      openGroup: (g) => channelsView(g),
      openChannel: (ch) => filesView(ch),
    }).then((idx) => {
      searchIndex = idx;
      return idx;
    }).catch((e) => {
      console.warn('[search]', e);
      searchIndexPromise = null;
      return [];
    });
    return searchIndexPromise;
  };

  const paintHome = () => {
    const nodes = [];
    // Buscador general
    const searchWrap = el('div', 'home-search-wrap');
    const s = el('input');
    s.id = 'home-search';
    s.type = 'text';
    s.inputMode = 'search';
    s.placeholder = 'Buscar editorial, canal, serie o cómic…';
    s.autocomplete = 'off';
    s.value = groupsView._q || '';
    const clearBtn = el('button', 'search-clear home-search-clear', '×');
    clearBtn.type = 'button';
    clearBtn.hidden = !s.value;
    clearBtn.setAttribute('aria-label', 'Cerrar búsqueda');
    clearBtn.onclick = () => {
      s.value = '';
      groupsView._q = '';
      clearBtn.hidden = true;
      showResults([], '');
      s.focus();
    };
    searchWrap.append(s, clearBtn);
    nodes.push(searchWrap);

    const resultsHost = el('div', 'home-search-results');
    resultsHost.hidden = true;
    // Clic fuera → cerrar listado y volver al home
    const onDocClick = (ev) => {
      if (!groupsView._q) return;
      if (searchWrap.contains(ev.target) || resultsHost.contains(ev.target)) return;
      s.value = '';
      groupsView._q = '';
      clearBtn.hidden = true;
      showResults([], '');
    };
    // showResults se declara después; envolver en función diferida
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocClick, true);
      groupsView._searchOutside = onDocClick;
    }, 0);
    nodes.push(resultsHost);

    const homeBody = el('div', 'home-body');
    nodes.push(homeBody);

    const fillHomeBody = () => {
      homeBody.replaceChildren();
      // Seguir leyendo: filtrar cómics que ya no existen en la caché del canal
      const rawContinue = getContinueList();
      const continueHost = el('div', 'continue-host');
      homeBody.append(continueHost);
      // Placeholder estable para no “saltar” al cargar async
      if (rawContinue.length) {
        const ph = el('details', 'pubs-fold continue-fold');
        if (pref('continueOpen', '1') === '1') ph.open = true;
        ph.append(el('summary', '', 'Seguir leyendo'));
        ph.append(el('div', 'continue-fold-body continue-placeholder'));
        continueHost.append(ph);
      }
      (async () => {
        const continueList = [];
        const seen = new Set();
        const addItem = (item) => {
          if (!item?.ch?.id || !item?.f?.id) return;
          const id = String(item.ch.id) + ':' + String(item.f.id);
          if (seen.has(id)) return;
          if (isComicRead(item.ch.id, item.f.id)) return;
          // No mostrar en Seguir leyendo si está bloqueado (sesión cerrada)
          if (locks.isContentRestricted('comic', { ch: item.ch, f: item.f })) return;
          seen.add(id);
          continueList.push(item);
        };

        for (const item of rawContinue) {
          try {
            // Solo caché local en Home (evitar fetch de red → parpadeo)
            const files = (await kv.get('f:' + item.ch.id)) || [];
            if (!files.length) {
              addItem(item);
              continue;
            }
            const f = files.find((x) => String(x.id) === String(item.f.id));
            if (f) addItem({ ...item, f: { id: f.id, name: f.name, size: f.size } });
          } catch (_) {
            addItem(item);
          }
        }

        // Progreso page: en localStorage aunque no esté en recentReads
        try {
          const lib = (Array.isArray(LIB) && LIB.length) ? LIB : ((await kv.get('lib')) || []);
          const byCh = new Map(lib.map((c) => [String(c.id), c]));
          for (const u of (listUnfinishedProgress || d.listUnfinishedProgress || (() => []))()) {
            const id = String(u.chId) + ':' + String(u.msgId);
            if (seen.has(id)) continue;
            const ch = byCh.get(String(u.chId));
            if (!ch) continue;
            const files = (await kv.get('f:' + ch.id)) || [];
            const f = files.find((x) => String(x.id) === String(u.msgId));
            if (f) addItem({ ch, f: { id: f.id, name: f.name, size: f.size }, at: Date.now() });
          }
        } catch (_) {}

        const renderContinue = (list) => {
          if (!continueHost.isConnected) return;
          const show = list.slice(0, 5);
          const fp = show.map((it) => String(it.ch?.id) + ':' + String(it.f?.id)).join('|');
          if (!show.length) {
            continueHost.replaceChildren();
            continueHost.dataset.fp = '';
            return;
          }
          // Evitar repintar idéntico (parpadeo / salto)
          if (continueHost.dataset.fp === fp && continueHost.querySelector('.continue-track')) return;
          continueHost.dataset.fp = fp;
          const foldCont = el('details', 'pubs-fold continue-fold');
          if (pref('continueOpen', '1') === '1') foldCont.open = true;
          const sumCont = el('summary', '', 'Seguir leyendo');
          foldCont.append(sumCont);
          const contInner = el('div', 'continue-fold-body');
          const track = el('div', 'continue-track');
          for (const item of show) {
            const ch = item.ch, f = item.f;
            const prog = readProgress(ch.id, f.id);
            const row = el('button', 'continue-row continue-slide');
            row.type = 'button';
            row.onclick = () => openComic(ch, f);
            const contLabel = comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch.name) || clean(f.name));
            const contUnread = !isComicRead(ch.id, f.id);
            const contRedraw = () => renderContinue(continueList);
            const channelLab = channelDisplayName(ch) || ch.name || '';
            let seriesLab = '';
            let titleLab = '';
            try {
              const ov = getComicSeriesOverride(ch, f);
              const p = parseComicName(comicSourceName(f), ch.name);
              const sk = (ov != null && String(ov).trim()) ? String(ov).trim() : (p?.series || seriesBase(f.name, ch.name) || '');
              seriesLab = sk ? (seriesDisplayName(ch, sk) || sk) : '';
              // Mismo formato que el listado dentro de una serie (#nn - info)
              const baseLabel = p ? issueDisplay(p) : (issueLabel(sk || seriesLab, f, ch.name) || comicDisplay(comicSourceName(f), ch.name) || clean(f.name));
              titleLab = comicDisplayName(ch, f, baseLabel);
            } catch (_) {
              titleLab = comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch.name) || clean(f.name));
            }
            bindLongPress(row, () => sheet(contLabel, comicSheetOpts(ch, f, contLabel, contRedraw, {
              seriesLabel: seriesLab || null,
              seriesFiles: null,
              groupState: seriesLab ? 'grouped' : null,
            }).concat(lockToggleOpts('comic', { ch, f }, contLabel, contRedraw))));
            const thumb = el('div', 'continue-cover');
            const letter = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
            thumb.append(letter);
            getCover(ch, f).then((b) => {
              if (!b || !thumb.isConnected) return;
              const img = new Image();
              img.onload = () => {
                try { letter.remove(); } catch (_) {}
                try {
                  if (img.naturalWidth > img.naturalHeight) {
                    thumb.classList.add('landscape');
                    try {
                      const fit = (typeof getCoverFit === 'function' ? getCoverFit(ch, f) : 'full') || 'full';
                      thumb.dataset.coverFit = fit;
                    } catch (_) { thumb.dataset.coverFit = 'full'; }
                  } else {
                    thumb.classList.remove('landscape');
                    try { delete thumb.dataset.coverFit; } catch (_) {}
                  }
                } catch (_) {}
                thumb.prepend(img);
              };
              setBlobImg(img, b, thumb);
            }).catch(() => {});
            const meta = el('div', 'continue-meta');
            if (channelLab) meta.append(el('span', 'continue-channel', channelLab));
            if (seriesLab) meta.append(el('span', 'continue-series', seriesLab));
            meta.append(el('span', 'continue-title', titleLab));
            meta.append(el('small', '', sizeLabel(f, ch)));
            if (prog) {
              const bar = el('div', 'continue-prog');
              const fill = el('div', 'continue-prog-fill');
              fill.style.width = prog.pct + '%';
              bar.append(fill);
              const lab = el('span', 'continue-prog-label', `${prog.cur} / ${prog.tot} · ${prog.pct}%`);
              meta.append(bar, lab);
            }
            row.append(thumb, meta);
            track.append(row);
          }
          contInner.append(track);
          foldCont.append(contInner);
          foldCont.addEventListener('toggle', () => setPref('continueOpen', foldCont.open ? '1' : '0'));
          continueHost.replaceChildren(foldCont);
        };

        // Evitar re-pintar si la lista no ha cambiado (parpadeo)
        const fp = continueList.map((it) => String(it.ch?.id) + ':' + String(it.f?.id)).join('|');
        if (continueHost.dataset.fp !== fp) {
          continueHost.dataset.fp = fp;
          renderContinue(continueList);
        }

        // Segundo plano: solo completar ítems que faltan en caché local (sin fetch de red si ya hay listado)
        (async () => {
          try {
            const lib = (Array.isArray(LIB) && LIB.length) ? LIB : ((await kv.get('lib')) || []);
            const byCh = new Map(lib.map((c) => [String(c.id), c]));
            const unfinished = (listUnfinishedProgress || d.listUnfinishedProgress || (() => []))();
            let added = false;
            for (const u of unfinished) {
              const id = String(u.chId) + ':' + String(u.msgId);
              if (seen.has(id)) continue;
              const ch = byCh.get(String(u.chId));
              if (!ch) continue;
              let files = [];
              try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) {}
              // Solo red si no hay listado en caché
              if (!files.length) {
                try { files = await fetchFiles(ch); } catch (_) {}
              }
              const f = files.find((x) => String(x.id) === String(u.msgId));
              if (f) {
                addItem({ ch, f: { id: f.id, name: f.name, size: f.size }, at: Date.now() });
                added = true;
              }
            }
            if (added && continueHost.isConnected) {
              const fp2 = continueList.map((it) => String(it.ch?.id) + ':' + String(it.f?.id)).join('|');
              if (continueHost.dataset.fp !== fp2) {
                continueHost.dataset.fp = fp2;
                renderContinue(continueList);
              }
            }
          } catch (_) {}
        })();
        return; // el render antiguo queda sustituido
        const foldCont = el('details', 'pubs-fold continue-fold');
        if (pref('continueOpen', '1') === '1') foldCont.open = true;
        const sumCont = el('summary', '', 'Seguir leyendo');
        foldCont.append(sumCont);
        const contInner = el('div', 'continue-fold-body');
        const track = el('div', 'continue-track');
        for (const item of continueList) {
          const ch = item.ch, f = item.f;
          const prog = readProgress(ch.id, f.id);
          const row = el('button', 'continue-row continue-slide');
          row.type = 'button';
          row.onclick = () => {
            if (!locks.guardRestricted('comic', { ch, f }, comicDisplayName(ch, f, clean(f.name)))) return;
            openComic(ch, f);
          };
          let thumb = el('div', 'continue-cover');
          if (locks.isContentRestricted('comic', { ch, f })) {
            thumb = locks.lockedCoverNode(ART);
            thumb.classList.add('continue-cover');
          } else {
            const letter = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
            thumb.append(letter);
            getCover(ch, f).then((b) => {
              if (!b || !thumb.isConnected) return;
              const img = new Image();
              img.onload = () => {
                try { letter.remove(); } catch (_) {}
                try {
                  if (img.naturalWidth > img.naturalHeight) {
                    thumb.classList.add('landscape');
                    try {
                      const fit = (typeof getCoverFit === 'function' ? getCoverFit(ch, f) : 'full') || 'full';
                      thumb.dataset.coverFit = fit;
                    } catch (_) { thumb.dataset.coverFit = 'full'; }
                  } else {
                    thumb.classList.remove('landscape');
                    try { delete thumb.dataset.coverFit; } catch (_) {}
                  }
                } catch (_) {}
                thumb.prepend(img);
              };
              setBlobImg(img, b, thumb);
            }).catch(() => {});
          }
          const meta = el('div', 'continue-meta');
          meta.append(el('b', '', comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch.name) || clean(f.name))));
          meta.append(el('small', '', sizeLabel(f, ch)));
          if (prog) {
            const bar = el('div', 'continue-prog');
            const fill = el('div', 'continue-prog-fill');
            fill.style.width = prog.pct + '%';
            bar.append(fill);
            const lab = el('span', 'continue-prog-label', `${prog.cur} / ${prog.tot} · ${prog.pct}%`);
            meta.append(bar, lab);
          }
          row.append(thumb, meta);
          track.append(row);
        }
        contInner.append(track);
        foldCont.append(contInner);
        foldCont.addEventListener('toggle', () => setPref('continueOpen', foldCont.open ? '1' : '0'));
        continueHost.replaceChildren(foldCont);
      })();
      const gs = [...new Set(LIB.map((c) => c.group))];
      gs.sort((a, b) => natural(groupDisplayName(a), groupDisplayName(b)));
      const fold = el('details', 'pubs-fold');
      if (pref('pubsOpen', '0') === '1') fold.open = true;
      const sum = el('summary', '', 'Editoriales');
      fold.append(sum);
      const g = el('div', 'grid grid-pubs');
      const redrawPubs = () => groupsView();
      for (const name of gs) {
        // Editorial bloqueada + candado cerrado → no se muestra en Home
        if (locks.isContentRestricted('group', name)) continue;
        const n = LIB.filter((c) => c.group === name).length;
        const label = groupDisplayName(name);
        g.append(cardNode({
          label,
          sub: n === 1 ? '1 canal' : `${n} canales`,
          cover: () => groupCoverNode(name),
          go: () => {
            if (!locks.guardRestricted('group', name, label)) return;
            channelsView(name);
          },
          longPress: () => {
            const opts = [
              ['Información', () => showGroupInfo(name)],
              ['Editar', () => showEditGroup(name, redrawPubs, () => sheet(label, opts))],
            ];
            if (locks.canUseLocks()) {
              if (locks.isGroupMarked(name)) {
                opts.push(['Desbloquear', async () => {
                  if (!locks.isSessionUnlocked()) {
                    const pw = await appPrompt('Contraseña de sincronización', 'Desbloquear', '', 'password');
                    if (pw == null) return;
                    if (!(await locks.unlockSession(pw))) return appAlert('Contraseña incorrecta', 'Desbloquear');
                  }
                  locks.setGroupLocked(name, false);
                  redrawPubs();
                }]);
              } else {
                opts.push(['Bloquear', async () => {
                  if (!locks.isSessionUnlocked()) {
                    await appAlert('Desbloquea el candado en el menú (☰) para marcar contenido.', 'Candado');
                    return;
                  }
                  locks.setGroupLocked(name, true);
                  redrawPubs();
                }]);
              }
            }
            sheet(label, opts);
          },
        }));
      }
      fold.append(g);
      fold.addEventListener('toggle', () => setPref('pubsOpen', fold.open ? '1' : '0'));
      homeBody.append(fold);

      // ---- Autores (debajo de Editoriales) ----
      const authorsFold = el('details', 'pubs-fold authors-fold');
      if (pref('authorsOpen', '0') === '1') authorsFold.open = true;
      authorsFold.append(el('summary', '', 'Autores'));
      const authorsBody = el('div', 'authors-fold-body');
      const authorSearch = el('input', 'edit-input');
      authorSearch.type = 'text';
      authorSearch.inputMode = 'search';
      authorSearch.placeholder = 'Buscar por guionista…';
      authorSearch.autocomplete = 'off';
      const authorTop = el('div', 'authors-top-list');
      const authorResults = el('div', 'home-search-results authors-results');
      authorResults.hidden = true;
      authorsBody.append(authorSearch, authorTop, authorResults);
      authorsFold.append(authorsBody);
      authorsFold.addEventListener('toggle', () => setPref('authorsOpen', authorsFold.open ? '1' : '0'));
      homeBody.append(authorsFold);

      const extractWriters = (caption) => {
        const people = [];
        try {
          if (typeof parseComicCaption === 'function') {
            const p = parseComicCaption(caption || '') || {};
            const raw = p.writer || p.guionista || p.Guionista || '';
            String(raw).split(/[,;\/&|]+|\s+y\s+|\s+and\s+/i).forEach((x) => {
              const n = String(x || '').trim();
              if (n && n.length > 1) people.push(n);
            });
            if (people.length) return people;
          }
        } catch (_) {}
        const m = String(caption || '').match(/Guionista\s*:\s*([^\n]+)/i);
        if (m) {
          m[1].split(/[,;\/&|]+|\s+y\s+|\s+and\s+/i).forEach((x) => {
            const n = String(x || '').trim();
            if (n && n.length > 1) people.push(n);
          });
        }
        return people;
      };

      const seriesNameOf = (ch, f) => {
        try {
          if (typeof getComicSeriesOverride === 'function') {
            const ov = getComicSeriesOverride(ch, f);
            if (ov != null && String(ov).trim()) return String(ov).trim();
          }
        } catch (_) {}
        try {
          // seriesOverrideFor(ch) devuelve (f)=>serie|null — no llamar como (ch,f)
          if (typeof seriesOverrideFor === 'function') {
            const fn = seriesOverrideFor(ch);
            if (typeof fn === 'function') {
              const ov = fn(f);
              if (ov != null && String(ov).trim()) return String(ov).trim();
            }
          }
        } catch (_) {}
        try {
          const src = (typeof comicSourceName === 'function' ? comicSourceName(f) : null) || f?.name || '';
          const p = typeof parseComicName === 'function' ? parseComicName(src, ch?.name) : null;
          if (p?.series) return String(p.series).trim();
        } catch (_) {}
        try {
          if (typeof seriesBase === 'function') {
            const b = seriesBase(f?.name || '', ch?.name);
            if (b && String(b).trim()) return String(b).trim();
          }
        } catch (_) {}
        return '';
      };

      const openAuthorView = (authorName, items, vopts = {}) => {
        const title = vopts.title || authorName || 'Autor';
        go(title, async () => {
          h1.textContent = title;
          // Cada vista (autor / autor·serie) guarda su propio orden
          const baseId = String(vopts.title || authorName || '');
          const groupKey = 'authorGroup:' + String(authorName || '');
          const NAT = { numeric: true, sensitivity: 'base' };
          const labelOf = (ch, f) => comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch?.name) || f?.name || '');
          const comics = (items || []).map(({ ch, f }) => ({
            ch, f, label: labelOf(ch, f), series: seriesNameOf(ch, f), date: captionDateOf(f),
          }));

          const renderComics = () => {
            const gi = comics.map((c) => {
              const { ch, f, label, series } = c;
              const sub = [ch?.name, series].filter(Boolean).join(' · ');
              const restricted = (() => {
                try { return locks.isContentRestricted('comic', { ch, f }); } catch (_) { return false; }
              })();
              return {
                kind: 'comic',
                _sortId: String(ch.id) + ':' + String(f.id),
                _sortLabel: label,
                _sortDate: c.date,
                _ch: String(ch?.name || ''),
                _series: String(series || ''),
                label: restricted ? '' : label,
                sub: restricted ? '' : sub,
                cover: () => restricted ? locks.lockedCoverNode(ART) : comicCover(ch, f),
                hiddenMeta: restricted,
                go: () => {
                  if (!locks.guardRestricted('comic', { ch, f }, label)) return;
                  openComic(ch, f);
                },
                longPress: () => sheet(label, comicSheetOpts(ch, f, label, render).concat(
                  lockToggleOpts('comic', { ch, f }, label, render)
                )),
              };
            });
            mountSortButton({
              title: 'Ordenar cómics de este autor',
              scope: 'author',
              id: baseId,
              getItems: () => gi,
              getId: (it) => it._sortId,
              getLabel: (it) => it._sortLabel || '',
              getDate: (it) => it._sortDate ?? null,
              onDone: () => render(),
            });
            const prefObj = getSortPref('author', baseId);
            const sorted = prefObj.mode === 'name'
              // Nombre (predeterminado): canal → serie → nombre
              ? gi.slice().sort((a, b) => a._ch.localeCompare(b._ch, undefined, NAT)
                || a._series.localeCompare(b._series, undefined, NAT)
                || natural(String(a._sortLabel), String(b._sortLabel)))
              : applySortList(gi, prefObj, (it) => it._sortId, (it) => it._sortLabel || '', (it) => it._sortDate ?? null);
            grid(sorted, false, '', 'comics');
          };

          const renderGrouped = () => {
            const groups = new Map();
            for (const c of comics) {
              const key = String(c.ch.id) + '\u0001' + (c.series || '');
              let g = groups.get(key);
              if (!g) { g = { ch: c.ch, series: c.series || '', list: [] }; groups.set(key, g); }
              g.list.push(c);
            }
            const gi = [...groups.entries()].map(([key, g]) => {
              const fs = g.list.map((c) => c.f);
              let shown = '(Sin serie)';
              if (g.series) {
                try { shown = seriesDisplayName(g.ch, g.series) || g.series; } catch (_) { shown = g.series; }
              }
              return {
                kind: 'series',
                _sortId: 'g:' + key,
                _sortLabel: (g.ch?.name || '') + ' · ' + shown,
                _sortDate: seriesFirstComicDate(fs, g.ch),
                _ch: String(g.ch?.name || ''),
                _series: String(shown),
                label: shown,
                sub: `${g.ch?.name || ''} · ${fs.length} cómic${fs.length === 1 ? '' : 's'}`,
                cover: () => seriesCoverNode(g.ch, g.series || shown, fs, fs.length),
                go: () => openAuthorView(
                  authorName,
                  g.list.map(({ ch, f }) => ({ ch, f })),
                  { title: `${authorName} · ${shown}`, noGroup: true }
                ),
              };
            });
            mountSortButton({
              title: 'Ordenar series de este autor',
              scope: 'authorSeries',
              id: baseId,
              getItems: () => gi,
              getId: (it) => it._sortId,
              getLabel: (it) => it._sortLabel || '',
              getDate: (it) => it._sortDate ?? null,
              onDone: () => render(),
            });
            const prefObj = getSortPref('authorSeries', baseId);
            const sorted = prefObj.mode === 'name'
              ? gi.slice().sort((a, b) => a._ch.localeCompare(b._ch, undefined, NAT)
                || a._series.localeCompare(b._series, undefined, NAT))
              : applySortList(gi, prefObj, (it) => it._sortId, (it) => it._sortLabel || '', (it) => it._sortDate ?? null);
            grid(sorted, false, '', 'series');
          };

          const render = () => {
            const grouped = !vopts.noGroup && (() => {
              try { return localStorage.getItem(groupKey) !== '0'; } catch (_) { return true; }
            })();
            if (grouped) renderGrouped(); else renderComics();
            if (!vopts.noGroup) {
              mountGroupButton({
                active: grouped,
                onToggle: () => {
                  try { localStorage.setItem(groupKey, grouped ? '0' : '1'); } catch (_) {}
                  render();
                },
              });
            }
          };
          render();
        });
      };

      const paintAuthorMatches = (matches) => {
        authorResults.replaceChildren();
        if (!matches.length) {
          authorResults.append(el('p', 'cover-pick-hint', 'Sin coincidencias'));
          return;
        }
        for (const e of matches) {
          const row = el('button', 'btn search-result-row');
          row.type = 'button';
          row.textContent = `${e.name} (${e.items.length})`;
          row.onclick = () => openAuthorView(e.name, e.items);
          authorResults.append(row);
        }
      };

      (async () => {
        const idx = new Map();
        for (const ch of (LIB || [])) {
          try { if (locks.isContentRestricted('channel', ch)) continue; } catch (_) {}
          let files = [];
          try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) { files = []; }
          for (const f of files) {
            if (!f) continue;
            try { if (locks.isContentRestricted('comic', { ch, f })) continue; } catch (_) {}
            for (const w of extractWriters(f.caption || '')) {
              const key = w.toLowerCase();
              let entry = idx.get(key);
              if (!entry) { entry = { name: w, items: [] }; idx.set(key, entry); }
              entry.items.push({ ch, f });
            }
          }
        }
        const ranked = [...idx.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
        authorTop.replaceChildren();
        for (const e of ranked.slice(0, 20)) {
          const row = el('button', 'btn search-result-row author-top-row');
          row.type = 'button';
          row.textContent = `${e.name} (${e.items.length})`;
          row.onclick = () => openAuthorView(e.name, e.items);
          authorTop.append(row);
        }
        if (!ranked.length) {
          authorTop.append(el('p', 'cover-pick-hint', 'No hay guionistas en los captions indexados.'));
        }
        authorSearch.oninput = () => {
          const q = authorSearch.value.trim().toLowerCase();
          if (!q) {
            authorResults.hidden = true;
            authorResults.replaceChildren();
            authorTop.hidden = false;
            return;
          }
          authorTop.hidden = true;
          authorResults.hidden = false;
          paintAuthorMatches(ranked.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 40));
        };
      })().catch((e) => console.warn('[authors]', e));
    };


    const showResults = (list, q) => {
      resultsHost.replaceChildren();
      if (!q) {
        resultsHost.hidden = true;
        homeBody.hidden = false;
        return;
      }
      homeBody.hidden = true;
      resultsHost.hidden = false;
      if (!list.length) {
        resultsHost.append(el('p', 'home-search-empty', 'Sin resultados para «' + q + '»'));
        return;
      }
      const meta = el('div', 'home-search-meta', list.length + (list.length === 1 ? ' resultado' : ' resultados'));
      resultsHost.append(meta);
      const listEl = el('div', 'home-search-list');
      for (const item of list.slice(0, 80)) {
        const btn = el('button', 'home-search-row');
        btn.type = 'button';
        const badge = el('span', 'home-search-badge type-' + (item.type || ''), item.typeLabel || '');
        const text = el('div', 'home-search-text');
        text.append(el('b', '', item.label));
        if (item.sub) text.append(el('small', '', item.sub));
        btn.append(badge, text);
        btn.onclick = () => item.go?.();
        if (typeof item.longPress === 'function' && typeof bindLongPress === 'function') {
          bindLongPress(btn, () => item.longPress());
        }
        listEl.append(btn);
      }
      if (list.length > 80) {
        listEl.append(el('p', 'home-search-empty', 'Mostrando 80 de ' + list.length + '… Afina la búsqueda.'));
      }
      resultsHost.append(listEl);
    };

    let timer = null;
    s.oninput = () => {
      const q = s.value.trim();
      groupsView._q = s.value;
      clearBtn.hidden = !s.value;
      clearTimeout(timer);
      if (!q) {
        showResults([], '');
        return;
      }
      resultsHost.hidden = false;
      homeBody.hidden = true;
      resultsHost.replaceChildren(el('p', 'home-search-empty', 'Buscando…'));
      timer = setTimeout(async () => {
        const qNorm = q.trim().toLowerCase().replace(/\s+/g, ' ');
        // Comando especial: listar/lista vine → cómics con ficha Telegram incompleta
        if (qNorm === 'listar vine' || qNorm === 'lista vine') {
          resultsHost.replaceChildren(el('p', 'home-search-empty', 'Buscando fichas incompletas…'));
          const missing = [];
          for (const ch of (LIB || [])) {
            try {
              if (locks.isContentRestricted('channel', ch)) continue;
            } catch (_) {}
            let files = [];
            try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) { files = []; }
            for (const f of files) {
              if (!f) continue;
              try {
                if (locks.isContentRestricted('comic', { ch, f })) continue;
              } catch (_) {}
              let needs = true;
              try {
                if (typeof comicNeedsCvFill === 'function') needs = !!comicNeedsCvFill(f, ch);
                else {
                  const cap = typeof parseComicCaption === 'function' ? parseComicCaption(f.caption || '') : {};
                  needs = !String(cap?.originalTitle || '').trim()
                    || !String(cap?.writer || '').trim()
                    || !String(cap?.artist || '').trim()
                    || !String(cap?.date || '').trim();
                }
              } catch (_) { needs = true; }
              if (!needs) continue;
              const label = comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch?.name) || f?.name || '');
              missing.push({
                type: 'comic',
                typeLabel: 'cómic',
                label,
                sub: (ch.name || '') + ' · ficha incompleta',
                ch, f,
                go: () => openComic(ch, f),
                longPress: () => {
                  try {
                    sheet(label, comicSheetOpts(ch, f, label, () => {}).concat(
                      lockToggleOpts('comic', { ch, f }, label, () => {})
                    ));
                  } catch (e) {
                    try { appAlert(String(e?.message || e)); } catch (_) {}
                  }
                },
              });
            }
          }
          missing.sort((a, b) => natural(a.label, b.label));
          showResults(missing, q);
          return;
        }
        const idx = await ensureIndex();
        let hits = filterSearchIndex(idx, q);
        // Ocultar resultados de contenido bloqueado (candado cerrado)
        hits = hits.filter((item) => {
          try {
            if (item.type === 'group') return !locks.isContentRestricted('group', item.group || item.label);
            if (item.type === 'channel') return !locks.isContentRestricted('channel', item.ch);
            if (item.type === 'series') return !locks.isContentRestricted('series', { ch: item.ch, seriesLabel: item.seriesLabel });
            if (item.type === 'comic') return !locks.isContentRestricted('comic', { ch: item.ch, f: item.f });
          } catch (_) {}
          return true;
        });
        if (pref('showUnreadOnly', '0') === '1') {
          hits = hits.filter((h) => {
            if (h.type === 'comic' && h.ch && h.f) return !isComicRead(h.ch.id, h.f.id);
            return true;
          });
        }
        if ((groupsView._q || '').trim() !== q) return;
        showResults(hits, q);
      }, 180);
    };

    app.replaceChildren(...nodes);
    fillHomeBody();
    if ((groupsView._q || '').trim()) {
      s.dispatchEvent(new Event('input'));
    }
    window.scrollTo(0, 0);
    setLastScrollY(0);
  };

  paintHome();
}
function channelsView(g) {
  const LIB = libNow();

  if (!locks.guardRestricted('group', g, groupDisplayName(g))) return;

  go(groupDisplayName(g), async (e) => {
    e._uploadCtx = { editorial: g };
    const chs = LIB.filter((c) => c.group === g);
    let searchIndex = null;

    const buildIndex = async () => {
      // Mismo formato que el buscador general, acotado a esta editorial
      return buildSearchIndex({
        LIB: chs,
        getFiles: async (ch) => (await kv.get('f:' + ch.id)) || [],
        groupDisplayName,
        channelDisplayName,
        seriesDisplayName,
        groupSeries,
        comicDisplay,
        comicDisplayName,
        openSeries: (ch, seriesLabel, fs) => seriesView(ch, seriesLabel, fs),
        openComic: (ch, f) => openComic(ch, f),
        openGroup: () => {},
        openChannel: (ch) => filesView(ch),
      });
    };

    const channelDate = async (ch) => {
      try {
        const files = (await kv.get('f:' + ch.id)) || [];
        let best = null;
        for (const f of files) {
          const d = captionDateOf(f);
          if (d == null) continue;
          if (best == null || d < best) best = d;
        }
        return best;
      } catch { return null; }
    };
    let channelDateCache = new Map();
    const ensureChannelDates = async () => {
      const prefObj = getSortPref('group-channels', g);
      if (prefObj.mode !== 'date') return;
      await Promise.all(chs.map(async (ch) => {
        if (channelDateCache.has(String(ch.id))) return;
        channelDateCache.set(String(ch.id), await channelDate(ch));
      }));
    };

    const build = async () => {
      if (!alive(e)) return;
      await ensureChannelDates();
      const prefObj = getSortPref('group-channels', g);
      const sortedChs = applySortList(
        chs,
        prefObj,
        (ch) => ch.id,
        (ch) => channelDisplayName(ch),
        (ch) => channelDateCache.get(String(ch.id)) ?? null
      );
      mountSortButton({
        title: 'Ordenar canales de esta editorial',
        scope: 'group-channels',
        id: g,
        getItems: () => chs,
        getId: (ch) => ch.id,
        getLabel: (ch) => channelDisplayName(ch),
        getDate: (ch) => channelDateCache.get(String(ch.id)) ?? null,
        onDone: async () => { await ensureChannelDates(); build(); },
      });
      const gridItems = [];
      for (const ch of sortedChs) {
        const files = (await kv.get('f:' + ch.id)) || [];
        const n = files.length;
        const label = channelDisplayName(ch);
        gridItems.push({
          kind: 'channel',
          cover: () => locks.isContentRestricted('channel', ch)
            ? locks.lockedCoverNode(ART)
            : channelCoverNode(ch, files),
          hiddenMeta: locks.isContentRestricted('channel', ch),
          label: locks.isContentRestricted('channel', ch) ? '' : label,
          sub: locks.isContentRestricted('channel', ch) ? '' : (n ? (n === 1 ? '1 cómic' : `${n} cómics`) : ''),
          isUnread: n ? files.some((f) => !isComicRead(ch.id, f.id)) : true,
          go: () => {
            if (!locks.guardRestricted('channel', ch, channelDisplayName(ch))) return;
            filesView(ch);
          },
          longPress: () => {
            const openRoot = () => sheet(label, opts);
            const opts = [
            ['Información', () => showChannelInfo(ch)],
            ['Editar', () => showEditChannel(ch, files, () => build(), openRoot)],
            ['Añadir versión WebP', () => {
              try { repackTool?.offerWebpVersionChannel?.(ch, files); }
              catch (e) { appAlert(e?.message || e); }
            }],
            ...lockToggleOpts('channel', ch, label, () => build()),
            ];
            openRoot();
          },
        });
      }
      gridItems.sort((a, b) => natural(a.label, b.label));

      // UI: buscador estilo home + grid de canales (o lista de resultados)
      const nodes = [];
      const searchWrap = el('div', 'home-search-wrap');
      const s = el('input');
      s.type = 'text';
      s.inputMode = 'search';
      s.placeholder = 'Buscar canal, serie o cómic en esta editorial…';
      s.autocomplete = 'off';
      s.value = channelsView._q?.[g] || '';
      const clearBtn = el('button', 'search-clear', '×');
      clearBtn.type = 'button';
      clearBtn.hidden = !s.value;
      clearBtn.setAttribute('aria-label', 'Cerrar búsqueda');
      searchWrap.append(s, clearBtn);
      nodes.push(searchWrap);

      const resultsHost = el('div', 'home-search-results');
      resultsHost.hidden = true;
      nodes.push(resultsHost);

      const gridHost = el('div', 'grid grid-channels');
      nodes.push(gridHost);

      const paintGrid = () => {
        gridHost.hidden = false;
        resultsHost.hidden = true;
        gridHost.replaceChildren(...gridItems.map((i) => cardNode(i)));
      };

      const showResults = (list, q) => {
        resultsHost.replaceChildren();
        if (!q) {
          paintGrid();
          return;
        }
        gridHost.hidden = true;
        resultsHost.hidden = false;
        if (!list.length) {
          resultsHost.append(el('p', 'home-search-empty', 'Sin resultados para «' + q + '»'));
          return;
        }
        // No mostrar filas de tipo "group" (es la editorial actual)
        const filtered = list.filter((x) => x.type !== 'group');
        resultsHost.append(el('div', 'home-search-meta', filtered.length + (filtered.length === 1 ? ' resultado' : ' resultados')));
        const listEl = el('div', 'home-search-list');
        for (const item of filtered.slice(0, 100)) {
          const btn = el('button', 'home-search-row');
          btn.type = 'button';
          btn.append(
            el('span', 'home-search-badge type-' + (item.type || ''), item.typeLabel || ''),
            (() => {
              const text = el('div', 'home-search-text');
              text.append(el('b', '', item.label));
              if (item.sub) text.append(el('small', '', item.sub));
              return text;
            })()
          );
          btn.onclick = () => item.go?.();
          listEl.append(btn);
        }
        resultsHost.append(listEl);
      };

      let timer = null;
      const runSearch = () => {
        const q = s.value.trim();
        if (!channelsView._q) channelsView._q = {};
        channelsView._q[g] = s.value;
        clearBtn.hidden = !s.value;
        clearTimeout(timer);
        if (!q) {
          showResults([], '');
          return;
        }
        resultsHost.hidden = false;
        gridHost.hidden = true;
        resultsHost.replaceChildren(el('p', 'home-search-empty', 'Buscando…'));
        timer = setTimeout(async () => {
          if (!searchIndex) searchIndex = await buildIndex();
          let hits = filterSearchIndex(searchIndex, q);
          if (pref('showUnreadOnly', '0') === '1') {
            hits = hits.filter((h) => {
              if (h.type === 'comic' && h.ch && h.f) return !isComicRead(h.ch.id, h.f.id);
              return true;
            });
          }
          if ((channelsView._q?.[g] || '').trim() !== q) return;
          showResults(hits, q);
        }, 180);
      };
      clearBtn.onclick = () => { s.value = ''; runSearch(); s.focus(); };
      s.oninput = runSearch;

      app.replaceChildren(...nodes);
      if (s.value.trim()) runSearch();
      else paintGrid();
      window.scrollTo(0, 0);
      setLastScrollY(0);
    };

    await build();
    mapLimit(chs, 3, async (ch) => {
      try {
        const fresh = await fetchFiles(ch);
        const cached = await kv.get('f:' + ch.id);
        if (JSON.stringify(fresh) !== JSON.stringify(cached)) {
          searchIndex = null;
          await build();
        }
      } catch (_) {}
    });
  });
}
function filesView(ch) {
  const LIB = libNow();

  if (!locks.guardRestricted('channel', ch, channelDisplayName(ch))) return;

  go(channelDisplayName(ch), async (e) => {
    e._uploadCtx = { editorial: ch.group || 'Sin editorial', channel: ch };
    e._chId = ch.id;
    let cur = [];
    let channelQueue = []; // cómics en el orden visible del canal
    const draw = (files) => {
      if (!alive(e)) return;
      cur = files;
      if (!files.length) return msg('No hay archivos CBZ/CBR en este canal.');
      const un = ungroupMap(ch), items = [], redraw = () => draw(cur);

      const makeComicItem = (f, displayLabel, seriesLabel, groupState, seriesFiles) => {
        // groupState: null = sin serie, 'grouped' | 'short' | 'full'
        const label = comicDisplayName(ch, f, displayLabel);
        const unread = !isComicRead(ch.id, f.id);
        const comicRestricted = locks.isContentRestricted('comic', { ch, f });
        const sheetCtx = {
          seriesLabel: seriesLabel || null,
          seriesFiles: seriesFiles || null,
          groupState: groupState || null,
        };
        return {
          // En la vista de series/canal, los cómics sueltos usan los ajustes de SERIES (misma portada y texto que el resto)
          kind: 'series',
          _f: f,
          _sortId: 'comic:' + String(f.id),
          _sortDate: captionDateOf(f),
          label: comicRestricted ? '' : label,
          sub: comicRestricted ? '' : sizeLabel(f, ch),
          searchText: (label + ' ' + (f.name || '') + ' ' + (seriesLabel || '')).toLowerCase(),
          isUnread: unread,
          cover: () => comicRestricted ? locks.lockedCoverNode(ART) : comicCover(ch, f),
          hiddenMeta: comicRestricted,
          go: () => {
            if (!locks.guardRestricted('comic', { ch, f }, label)) return;
            openComic(ch, f, channelQueue.length ? channelQueue : cur);
          },
          longPress: () => sheet(label, comicSheetOpts(ch, f, label, redraw, sheetCtx).concat(
            lockToggleOpts('comic', { ch, f }, label, redraw)
          )),
          menu: (groupState && seriesLabel) ? () => sheet(
            seriesDisplayName(ch, seriesLabel),
            seriesSheetOpts(ch, seriesLabel, seriesFiles || [], redraw, { groupState })
              .concat(lockToggleOpts('series', { ch, seriesLabel }, seriesDisplayName(ch, seriesLabel), redraw))
          ) : undefined,
        };
      };

      for (const { label: seriesLabel, files: fs } of groupSeries(files, ch.name, seriesOverrideFor(ch))) {
        const seriesShown = seriesDisplayName(ch, seriesLabel);
        if (fs.length === 1) {
          const f = fs[0];
          // Si el parseo detectó serie aunque sea 1 archivo, permitir editar nombre de serie
          const p = parseComicName(comicSourceName(f), ch.name);
          const ov = getComicSeriesOverride(ch, f);
          const soloSeries = ov || p?.series || seriesLabel;
          const hasSeriesName = !!(ov || p?.series);
          items.push(makeComicItem(
            f,
            comicDisplay(comicSourceName(f), ch.name),
            hasSeriesName ? soloSeries : null,
            hasSeriesName ? 'grouped' : null
          ));
          // Un solo número: no desagrupar; si hasSeriesName Editar título + Editar serie + Info
          if (hasSeriesName) {
            const it = items[items.length - 1];
            it.longPress = () => sheet(it.label, comicSheetOpts(ch, f, it.label, redraw, {
              seriesLabel: soloSeries,
              seriesFiles: fs,
              groupState: 'grouped',
            }).concat(lockToggleOpts('comic', { ch, f }, it.label, redraw)));
            it.menu = undefined;
          }
        } else if (un[seriesLabel.toLowerCase()]) {
          const mode = un[seriesLabel.toLowerCase()];
          fs.forEach((f) => {
            const displayLabel = mode === 'short'
              ? issueLabel(seriesLabel, f, ch.name)
              : comicDisplay(comicSourceName(f), ch.name);
            items.push(makeComicItem(f, displayLabel, seriesLabel, mode, fs));
          });
        } else {
          const seriesUnread = fs.some((f) => !isComicRead(ch.id, f.id));
          const seriesOpts = seriesSheetOpts(ch, seriesLabel, fs, redraw, { groupState: 'grouped' });
          const seriesSearch = (seriesShown + ' ' + seriesLabel + ' ' + fs.map((f) => f.name).join(' ')).toLowerCase();
          const seriesRestricted = locks.isContentRestricted('series', { ch, seriesLabel });
          const seriesLockOpts = () => lockToggleOpts('series', { ch, seriesLabel }, seriesDisplayName(ch, seriesLabel), redraw);
          const seriesDate = seriesFirstComicDate(fs, ch);
          items.push({
            kind: 'series',
            _sortId: 'series:' + String(seriesLabel),
            _sortDate: seriesDate,
            label: seriesRestricted ? '' : seriesShown,
            sub: `${fs.length} números`,
            searchText: seriesSearch,
            isUnread: seriesUnread,
            cover: () => locks.isContentRestricted('series', { ch, seriesLabel })
              ? locks.lockedCoverNode(ART)
              : seriesCoverNode(ch, seriesLabel, fs, fs.length),
            hiddenMeta: seriesRestricted,
            go: () => {
              if (!locks.guardRestricted('series', { ch, seriesLabel }, seriesDisplayName(ch, seriesLabel))) return;
              seriesView(ch, seriesLabel, fs);
            },
            // Serie bloqueada: solo opciones de bloqueo (sin Información/Editar); si no, menú completo + bloqueo
            longPress: () => seriesRestricted
              ? sheet(seriesDisplayName(ch, seriesLabel), seriesLockOpts())
              : sheet(seriesShown, [...seriesOpts, ...seriesLockOpts()]),
            menu: () => sheet(seriesShown, [...seriesOpts, ...seriesLockOpts()]),
          });
        }
      }
      // Orden según preferencia del canal (nombre / fecha / manual)
      // Adjuntar clave y fecha para ordenar series y cómics sueltos
      for (const it of items) {
        if (it._sortId == null) {
          // series card: label+kind; comic: use searchText hash fallback
          it._sortId = it.kind + ':' + (it.label || it.searchText || Math.random());
        }
      }
      // Rellenar fechas: series = min date of members; comics set in makeComicItem
      const prefObj = getSortPref('channel', ch.id);
      mountSortButton({
        title: 'Ordenar series y cómics de este canal',
        scope: 'channel',
        id: ch.id,
        getItems: () => items,
        getId: (it) => it._sortId,
        getLabel: (it) => it.label || it.searchText || '',
        getDate: (it) => it._sortDate ?? null,
        onDone: () => draw(cur),
      });
      const sorted = applySortList(
        items,
        prefObj,
        (it) => it._sortId,
        (it) => it.label || '',
        (it) => it._sortDate ?? null
      );
      channelQueue = sorted.filter((it) => it._f).map((it) => it._f);
      grid(sorted, true, 'Buscar en este canal…', 'mixed');
    };
    const cached = await kv.get('f:' + ch.id);
    if (cached) draw(cached); else msg('Cargando…');
    try {
      const fresh = await fetchFiles(ch);
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) draw(fresh);
    } catch (err) { if (!cached) msg('Error: ' + err.message); }
  });
}
function seriesView(ch, s, files) {
  const LIB = libNow();

  if (!locks.guardRestricted('series', { ch, seriesLabel: s }, seriesDisplayName(ch, s))) return;

  const title = seriesDisplayName(ch, s);
  go(title, (e) => {
    e._uploadCtx = {
      editorial: ch.group || 'Sin editorial',
      channel: ch,
      // Nombre visible de la serie (renombres locales) para el formulario de subida
      series: (seriesDisplayName(ch, s) || s || '').trim(),
      seriesKey: s,
    };
    e._chId = ch.id;
    e._seriesKey = s;

    const loadSeriesFiles = async () => {
      let all = [];
      try { all = (await kv.get('f:' + ch.id)) || []; } catch (_) {}
      if (!all.length) {
        try { all = await fetchFiles(ch); } catch (_) {}
      }
      if (!all.length && Array.isArray(files) && files.length) all = files;
      const groups = groupSeries(all, ch.name, seriesOverrideFor(ch));
      const key = String(s || '').toLowerCase();
      let match = groups.find((g) => String(g.label || '').toLowerCase() === key);
      if (!match) {
        match = groups.find((g) =>
          String(seriesDisplayName(ch, g.label) || '').toLowerCase() === key
        );
      }
      return match ? match.files : (Array.isArray(files) ? files : []);
    };

    const redraw = async () => {
      if (!alive(e)) return;
      const fs = await loadSeriesFiles();
      if (!alive(e)) return;
      try {
        const t = seriesDisplayName(ch, s);
        if (titleEl) titleEl.textContent = t;
      } catch (_) {}
      const seriesUnread = fs.some((x) => !isComicRead(ch.id, x.id));
      let seriesQueue = fs;
      const items = fs.map((f) => {
        const p = parseComicName(comicSourceName(f), ch.name);
        const baseLabel = (p && String(p.series || '').toLowerCase() === String(s).toLowerCase())
          ? issueDisplay(p)
          : issueLabel(s, f, ch.name);
        const displayLabel = comicDisplayName(ch, f, baseLabel);
        const unread = !isComicRead(ch.id, f.id);
        const seriesRedraw = () => {
          try { if (titleEl) titleEl.textContent = seriesDisplayName(ch, s); } catch (_) {}
          redraw();
        };
        return {
          kind: 'comic',
          _f: f,
          _sortId: String(f.id),
          _sortDate: captionDateOf(f),
          label: displayLabel,
          sub: sizeLabel(f, ch),
          searchText: (displayLabel + ' ' + (f.name || '')).toLowerCase(),
          isUnread: unread,
          cover: () => locks.isContentRestricted('comic', { ch, f }) ? locks.lockedCoverNode(ART) : comicCover(ch, f),
          hiddenMeta: locks.isContentRestricted('comic', { ch, f }),
          go: () => openComic(ch, f, seriesQueue),
          longPress: () => sheet(displayLabel, comicSheetOpts(ch, f, displayLabel, seriesRedraw, {
            seriesLabel: s,
            seriesFiles: fs,
            groupState: 'grouped',
            afterDesagrupar: () => history.back(),
          }).concat(lockToggleOpts('comic', { ch, f }, displayLabel, seriesRedraw))),
        };
      });
      const prefObj = getSortPref('series', String(ch.id) + ':' + String(s));
      mountSortButton({
        title: 'Ordenar cómics de esta serie',
        scope: 'series',
        id: String(ch.id) + ':' + String(s),
        getItems: () => items,
        getId: (it) => it._sortId,
        getLabel: (it) => it.label || '',
        getDate: (it) => it._sortDate ?? null,
        onDone: () => redraw(),
      });
      const sorted = applySortList(
        items,
        prefObj,
        (it) => it._sortId,
        (it) => it.label || '',
        (it) => it._sortDate ?? null
      );
      seriesQueue = sorted.map((it) => it._f).filter(Boolean);
      grid(sorted, true, 'Buscar en esta serie…', 'comics');
    };
    redraw();
  });
}


  return {
    cardNode,
    lockToggleOpts,
    groupsView,
    channelsView,
    filesView,
    seriesView,
  };
}
