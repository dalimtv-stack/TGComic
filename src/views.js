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
    showSeriesInfo, showEditSeries, showComicInfo, showEditComicTitle,
    ungroupMap, setUngroupMode, getComicSeriesOverride,
    firstAvailableCover, kv, natural,
    pref, setPref,
    appAlert, appConfirm, appPrompt,
    parseComicName, issueDisplay,
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
    s.type = 'search';
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
            const contOpts = [
              ['Información', () => showComicInfo(ch, f, contLabel)],
              ['Editar datos del comic', () => showEditComicTitle(ch, f, contLabel, () => {
                try { if (stack.length === 1) groupsView(); } catch (_) {}
              })],
              contUnread
                ? ['Marcar comic como leído', () => markComicRead(ch, f, () => renderContinue(continueList))]
                : ['Marcar comic como no leído', () => markComicUnread(ch, f, () => renderContinue(continueList))],
              ['Añadir versión WebP', () => { try { repackTool?.offerWebpVersion?.(ch, f); } catch (e) { appAlert(e?.message || e); } }],
            ];
            bindLongPress(row, () => sheet(contLabel, contOpts));
            const thumb = el('div', 'continue-cover');
            const letter = el('span', '', stripExt(f.name).slice(0, 1).toUpperCase());
            thumb.append(letter);
            getCover(ch, f).then((b) => {
              if (!b || !thumb.isConnected) return;
              const img = new Image();
              img.onload = () => {
                try { letter.remove(); } catch (_) {}
                try {
                  if (img.naturalWidth > img.naturalHeight) thumb.classList.add('landscape');
                  else thumb.classList.remove('landscape');
                } catch (_) {}
                thumb.prepend(img);
              };
              setBlobImg(img, b, thumb);
            }).catch(() => {});
            const meta = el('div', 'continue-meta');
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
                  if (img.naturalWidth > img.naturalHeight) thumb.classList.add('landscape');
                  else thumb.classList.remove('landscape');
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
            ...lockToggleOpts('channel', ch, label, () => build()),
          ]),
        });
      }
      gridItems.sort((a, b) => natural(a.label, b.label));

      // UI: buscador estilo home + grid de canales (o lista de resultados)
      const nodes = [];
      const searchWrap = el('div', 'home-search-wrap');
      const s = el('input');
      s.type = 'search';
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
        const opts = [
          ['Información', () => showComicInfo(ch, f, label)],
          ['Editar datos del comic', () => showEditComicTitle(ch, f, label, redraw)],
        ];
        if (seriesLabel && groupState) {
          opts.push(['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, seriesFiles || [], redraw)]);
        }
        opts.push(unread
          ? ['Marcar comic como leído', () => markComicRead(ch, f, redraw)]
          : ['Marcar comic como no leído', () => markComicUnread(ch, f, redraw)]);
        // Solo la acción que proceda para la serie completa
        if (seriesLabel && seriesFiles && seriesFiles.length > 1) {
          const anyUnread = seriesFiles.some((x) => !isComicRead(ch.id, x.id));
          opts.push(anyUnread
            ? ['Marcar serie como leída', () => markSeriesRead(ch, seriesFiles, redraw)]
            : ['Marcar serie como no leída', () => markSeriesUnread(ch, seriesFiles, redraw)]);
        }
        if (groupState === 'short' || groupState === 'full') {
          opts.push(['Volver a agrupar la serie', () => setUngroupMode(ch, seriesLabel, null, redraw)]);
        } else if (groupState === 'grouped' && seriesFiles && seriesFiles.length > 1) {
          opts.push(['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)]);
          opts.push(['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)]);
        }
        opts.push(['Añadir versión WebP', () => {
          try { repackTool?.offerWebpVersion?.(ch, f); }
          catch (e) { appAlert(e?.message || e); }
        }]);
        const comicRestricted = locks.isContentRestricted('comic', { ch, f });
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
          longPress: () => sheet(label, opts.concat(lockToggleOpts('comic', { ch, f }, label, redraw))),
          menu: (groupState && seriesLabel) ? () => sheet(seriesDisplayName(ch, seriesLabel), [
            ['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, seriesFiles || [], redraw)],
            ...lockToggleOpts('series', { ch, seriesLabel }, seriesDisplayName(ch, seriesLabel), redraw),
            ...(seriesFiles && seriesFiles.length > 1
              ? [seriesFiles.some((x) => !isComicRead(ch.id, x.id))
                  ? ['Marcar serie como leída', () => markSeriesRead(ch, seriesFiles, redraw)]
                  : ['Marcar serie como no leída', () => markSeriesUnread(ch, seriesFiles, redraw)]]
              : []),
            ...(groupState === 'grouped' && seriesFiles?.length > 1
              ? [['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)],
                 ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)]]
              : groupState === 'short' || groupState === 'full'
                ? [['Volver a agrupar la serie', () => setUngroupMode(ch, seriesLabel, null, redraw)]]
                : []),
          ]) : undefined,
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
            it.longPress = () => sheet(it.label, [
              ['Información', () => showComicInfo(ch, f, it.label)],
              ['Editar datos del comic', () => showEditComicTitle(ch, f, it.label, redraw)],
              ['Editar TODA la serie', () => showEditSeries(ch, soloSeries, fs, redraw)],
              !isComicRead(ch.id, f.id)
                ? ['Marcar comic como leído', () => markComicRead(ch, f, redraw)]
                : ['Marcar comic como no leído', () => markComicUnread(ch, f, redraw)],
              ['Añadir versión WebP', () => { try { repackTool?.offerWebpVersion?.(ch, f); } catch (e) { appAlert(e?.message || e); } }],
            ]);
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
          const seriesOpts = [
            ['Información', () => showSeriesInfo(ch, seriesLabel, fs)],
            ['Editar TODA la serie', () => showEditSeries(ch, seriesLabel, fs, redraw)],
            seriesUnread
              ? ['Marcar serie como leída', () => markSeriesRead(ch, fs, redraw)]
              : ['Marcar serie como no leída', () => markSeriesUnread(ch, fs, redraw)],
            ['Desagrupar serie', () => setUngroupMode(ch, seriesLabel, 'short', redraw)],
            ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, seriesLabel, 'full', redraw)],
          ];
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
        const opts = [
          ['Información', () => showComicInfo(ch, f, displayLabel)],
          ['Editar datos del comic', () => showEditComicTitle(ch, f, displayLabel, redraw)],
          ['Editar TODA la serie', () => showEditSeries(ch, s, fs, () => {
            try { titleEl.textContent = seriesDisplayName(ch, s); } catch (_) {}
            redraw();
          })],
          unread
            ? ['Marcar comic como leído', () => markComicRead(ch, f, redraw)]
            : ['Marcar comic como no leído', () => markComicUnread(ch, f, redraw)],
          seriesUnread
            ? ['Marcar serie como leída', () => markSeriesRead(ch, fs, redraw)]
            : ['Marcar serie como no leída', () => markSeriesUnread(ch, fs, redraw)],
          ['Desagrupar serie', () => setUngroupMode(ch, s, 'short', () => history.back())],
          ['Desagrupar serie (con nombre)', () => setUngroupMode(ch, s, 'full', () => history.back())],
          ['Añadir versión WebP', () => { try { repackTool?.offerWebpVersion?.(ch, f); } catch (err) { appAlert(err?.message || err); } }],
        ];
        return {
          kind: 'comic',
          label: displayLabel,
          sub: sizeLabel(f, ch),
          searchText: (displayLabel + ' ' + (f.name || '')).toLowerCase(),
          isUnread: unread,
          cover: () => locks.isContentRestricted('comic', { ch, f }) ? locks.lockedCoverNode(ART) : comicCover(ch, f),
          hiddenMeta: locks.isContentRestricted('comic', { ch, f }),
          go: () => openComic(ch, f, fs),
          longPress: () => sheet(displayLabel, opts.concat(lockToggleOpts('comic', { ch, f }, displayLabel, redraw))),
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
