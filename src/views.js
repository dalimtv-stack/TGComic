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
    showSeriesInfo, showEditSeries, showSeriesCvFillForm, showComicInfo, showEditComicTitle,
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
          ['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, files, redraw)],
          ['Recargar fichas Telegram (Cómic Vine)', () => {
            if (typeof showSeriesCvFillForm === 'function') {
              showSeriesCvFillForm(ch, seriesLabel, files, { overwrite: true });
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

    const opts = [
      ['Información', () => showComicInfo(ch, f, label)],
      ['Editar', () => {
        const openEditMenu = () => {
          const editOpts = [
            ['Editar datos del cómic', () => showEditComicTitle(ch, f, label, redraw)],
          ];
          if (seriesLabel) {
            editOpts.push(['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, seriesFiles || [f], redraw)]);
          }
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
        ]);
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
              ['Editar', () => showEditGroup(name, redrawPubs)],
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
            String(raw).split(/[,;\/&]+/).forEach((x) => {
              const n = String(x || '').trim();
              if (n && n.length > 1) people.push(n);
            });
            if (people.length) return people;
          }
        } catch (_) {}
        const m = String(caption || '').match(/Guionista\s*:\s*([^\n]+)/i);
        if (m) {
          m[1].split(/[,;\/&]+/).forEach((x) => {
            const n = String(x || '').trim();
            if (n && n.length > 1) people.push(n);
          });
        }
        return people;
      };

      const seriesNameOf = (ch, f) => {
        try {
          if (typeof seriesOverrideFor === 'function') {
            const ov = seriesOverrideFor(ch, f);
            if (ov && String(ov).trim()) return String(ov).trim();
          }
        } catch (_) {}
        try {
          if (typeof groupSeries === 'function') {
            const g = groupSeries(f?.name || '', ch?.name);
            if (g && String(g).trim()) return String(g).trim();
          }
        } catch (_) {}
        try {
          const p = parseComicName?.(comicSourceName?.(f) || f?.name || '', ch?.name);
          if (p?.series) return String(p.series).trim();
        } catch (_) {}
        return '';
      };

      const openAuthorView = (authorName, items) => {
        const title = authorName || 'Autor';
        go(title, async () => {
          h1.textContent = title;
          const list = (items || []).slice().sort((a, b) => {
            const ca = String(a.ch?.name || '');
            const cb = String(b.ch?.name || '');
            let c = ca.localeCompare(cb, undefined, { numeric: true, sensitivity: 'base' });
            if (c) return c;
            const sa = seriesNameOf(a.ch, a.f);
            const sb = seriesNameOf(b.ch, b.f);
            c = sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
            if (c) return c;
            const la = comicDisplayName(a.ch, a.f, comicDisplay(comicSourceName(a.f), a.ch?.name) || a.f?.name || '');
            const lb = comicDisplayName(b.ch, b.f, comicDisplay(comicSourceName(b.f), b.ch?.name) || b.f?.name || '');
            return natural(la, lb);
          });
          const redraw = () => openAuthorView(authorName, items);
          const itemsForGrid = list.map(({ ch, f }) => {
            const label = comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch?.name) || f?.name || '');
            const ser = seriesNameOf(ch, f);
            const sub = [ch?.name, ser].filter(Boolean).join(' · ');
            const comicRestricted = (() => {
              try { return locks.isContentRestricted('comic', { ch, f }); } catch (_) { return false; }
            })();
            return {
              kind: 'comic',
              label: comicRestricted ? '' : label,
              sub: comicRestricted ? '' : sub,
              cover: () => comicRestricted
                ? locks.lockedCoverNode(ART)
                : comicCover(ch, f),
              hiddenMeta: comicRestricted,
              go: () => {
                if (!locks.guardRestricted('comic', { ch, f }, label)) return;
                openComic(ch, f);
              },
              longPress: () => sheet(label, comicSheetOpts(ch, f, label, redraw).concat(
                lockToggleOpts('comic', { ch, f }, label, redraw)
              )),
            };
          });
          grid(itemsForGrid, false, '', 'comics');
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

    const build = async () => {
      if (!alive(e)) return;
      const gridItems = [];
      for (const ch of chs) {
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
          longPress: () => sheet(label, [
            ['Información', () => showChannelInfo(ch)],
            ['Editar', () => showEditChannel(ch, files, () => build())],
            ['Añadir versión WebP', () => {
              try { repackTool?.offerWebpVersionChannel?.(ch, files); }
              catch (e) { appAlert(e?.message || e); }
            }],
            ...lockToggleOpts('channel', ch, label, () => build()),
          ]),
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
          label: comicRestricted ? '' : label,
          sub: comicRestricted ? '' : sizeLabel(f, ch),
          searchText: (label + ' ' + (f.name || '') + ' ' + (seriesLabel || '')).toLowerCase(),
          isUnread: unread,
          cover: () => comicRestricted ? locks.lockedCoverNode(ART) : comicCover(ch, f),
          hiddenMeta: comicRestricted,
          go: () => {
            if (!locks.guardRestricted('comic', { ch, f }, label)) return;
            openComic(ch, f, cur);
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
          items.push({
            kind: 'series',
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
      // Orden alfabético por el nombre visible (incluye series renombradas)
      items.sort((a, b) => natural(a.label, b.label));
      grid(items, true, 'Buscar en este canal…', 'mixed');
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
          label: displayLabel,
          sub: sizeLabel(f, ch),
          searchText: (displayLabel + ' ' + (f.name || '')).toLowerCase(),
          isUnread: unread,
          cover: () => locks.isContentRestricted('comic', { ch, f }) ? locks.lockedCoverNode(ART) : comicCover(ch, f),
          hiddenMeta: locks.isContentRestricted('comic', { ch, f }),
          go: () => openComic(ch, f, fs),
          longPress: () => sheet(displayLabel, comicSheetOpts(ch, f, displayLabel, seriesRedraw, {
            seriesLabel: s,
            seriesFiles: fs,
            groupState: 'grouped',
            afterDesagrupar: () => history.back(),
          }).concat(lockToggleOpts('comic', { ch, f }, displayLabel, seriesRedraw))),
        };
      });
      grid(items, true, 'Buscar en esta serie…', 'comics');
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
