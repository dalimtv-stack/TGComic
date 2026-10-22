import { isComicRead, getPageIndex, getPagesTotal, readProgress } from './progress.js';
import * as sync from './sync.js';

/**
 * Información y edición: cómic, serie, canal, editorial; selectores de portada.
 */
export function createInfoEdit(d) {
  const {
    el, kv, Api, peerOf,
    locks,
    parseComicName, comicSourceName, issueDisplay, comicDisplay, clean, stripExt,
    parseComicCaption, buildComicCaption,
    groupSeries, seriesOverrideFor, seriesBase, issueLabel,
    comicDisplayName, setComicDisplayName,
    getCoverFit, setCoverFit,
    getMsg, openPages, pageBlob,
    seriesDisplayName, setSeriesDisplayName,
    channelDisplayName, setChannelDisplayName,
    groupDisplayName, setGroupDisplayName,
    getComicSeriesOverride, setComicSeries, ungroupMap, setUngroupMode,
    getPageIndex, getPagesTotal, getPageFormat, formatBytes, sizeLabel,
    getCover, saveCoverBlob, optimizeImageBlob, comicCover, io,
    art, ART, artNorm, artLoose, listGithubArtVariants, probeGithubArtVariants,
    fetchOptimizeArtBlob,
    setBlobImg,
    appAlert, appConfirm, appPrompt, sheet, bindLongPress, grid, copyInfoFrameText, formatPeople, showDescriptionPanel,
    comicVineConfigured, searchIssuesSmart, fetchIssueDetail, buildSearchQuery,
    listAllIssuesForVolume, parseVolumeIdFromUrl, listIssuesForVolume,
    go, show, stack, natural,
  } = d;

  // Aliases for helpers that may be on d as functions defined later
  const channelCoverKey = (ch) => `cc:${ch.id}`;
  const seriesCoverKey = (ch, label) => `sc:${ch.id}:${String(label || '').toLowerCase()}`;
  const groupCoverKey = (name) => `gc:${artNorm(String(name || ''))}`;

  // Nunca hacer snapshot de client/ready/LIB: se rellenan tras el login
  const getClient = () => (typeof d.client === 'function' ? d.client() : d.client);
  const getReady = () => (typeof d.ready === 'function' ? d.ready() : d.ready);
  const getLIB = () => {
    const L = typeof d.LIB === 'function' ? d.LIB() : d.LIB;
    return Array.isArray(L) ? L : [];
  };

function showComicInfo(ch, f, displayTitle) {
  try {
    document.querySelector('.info-frame.comic-info')?.remove();
    const cap = parseComicCaption(f?.caption || '');
    const parsed = parseComicName(comicSourceName(f), ch?.name);
    // Serie = override de agrupación o la del nombre de archivo
    let seriesKey = (ch && f ? getComicSeriesOverride(ch, f) : null)
      || parsed?.series || seriesBase(f?.name || '', ch?.name) || '';
    seriesKey = String(seriesKey || '').trim();
    let series = seriesKey || '—';
    // Título: con serie → solo "#nn - info" (como bajo la portada en la serie).
    // Se parte del caption (Título España) o del nombre de archivo, nunca "Serie #nn".
    const issueFromFile = parsed ? issueDisplay(parsed) : '';
    let title = '—';
    if (ch && f) {
      if (seriesKey) {
        // Forzar contexto "serie" con fallback que empieza por #
        const fb = issueFromFile || '#';
        title = comicDisplayName(ch, f, fb.startsWith('#') ? fb : ('#' + fb)) || fb;
        // Por si quedó "Badlands #007"
        if (title && !/^#/.test(title.trim())) {
          const mh = title.match(/#\s*(.+)$/);
          title = mh ? ('#' + mh[1].replace(/^#\s*/, '').trim()) : (issueFromFile || title);
        }
        // "#01 -" / "#01 - [Traducido]" residual
        title = String(title || '')
          .replace(/\s*\[[^\]]*\]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
          .trim() || issueFromFile || title;
      } else {
        title = comicDisplayName(ch, f, comicDisplay(comicSourceName(f), ch.name) || clean(f.name))
          || comicDisplay(comicSourceName(f), ch.name)
          || '—';
      }
    } else if (displayTitle) {
      title = String(displayTitle).trim();
    }
    const fname = f?.name || '';
    const fmt = /\.cbz$/i.test(fname) ? 'CBZ (ZIP)' : /\.cbr$/i.test(fname) ? 'CBR (RAR)' : '—';
    const pages = (ch && f) ? getPagesTotal(ch.id, f.id) : 0;
    const pagesLabel = pages > 0 ? String(pages) : '— (se conoce al abrir)';
    let pageFmt = '— (se detecta al abrir)';
    try {
      const storedFmt = (ch && f) ? getPageFormat(ch.id, f.id) : '';
      if (storedFmt) pageFmt = storedFmt;
      else if (pages > 0) pageFmt = '—';
    } catch (_) {}

    const frame = el('div', 'info-frame comic-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    const titleSpan = el('span', 'info-head-title', 'Información');
    titleSpan.title = 'Pulsa para copiar';
    head.append(titleSpan);
    const close = el('button', 'btn info-close', '×');
    close.setAttribute('aria-label', 'Cerrar');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    titleSpan.onclick = (ev) => {
      ev.stopPropagation();
      copyInfoFrameText(body);
      titleSpan.textContent = 'Copiado';
      setTimeout(() => { titleSpan.textContent = 'Información'; }, 1200);
    };
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Archivo'));
    body.append(row('Título', title));
    body.append(row('Serie', series));
    body.append(row('Canal', ch ? channelDisplayName(ch) : '—'));
    body.append(row('Editorial canal', ch?.group || '—'));
    body.append(row('Archivo', fname || '—'));
    body.append(row('Formato', fmt));
    body.append(row('Tamaño', formatBytes(f?.size)));
    body.append(row('Páginas', pagesLabel));
    body.append(row('Formato pág.', pageFmt));
    // Ficha "completa" = hay algo más que solo Nombre de archivo
    const hasExtraFicha = !!(cap.titleEs || cap.originalTitle || cap.series || cap.writer || cap.artist || cap.publisher || cap.date || cap.description);
    const hasAnyFicha = !!(cap.fileName || hasExtraFicha);
    body.append(el('div', 'info-sec', 'Ficha en Telegram'));
    if (hasAnyFicha) {
      if (cap.fileName) body.append(row('Nombre de archivo', cap.fileName));
      if (cap.titleEs) body.append(row('Título España', cap.titleEs));
      if (cap.originalTitle) body.append(row('Título original', cap.originalTitle));
      if (cap.series) body.append(row('Serie', cap.series));
      if (cap.writer) body.append(row('Guionista', formatPeople(cap.writer)));
      if (cap.artist) body.append(row('Dibujante', formatPeople(cap.artist)));
      if (cap.publisher) body.append(row('Editorial', cap.publisher));
      if (cap.date) body.append(row('Fecha de publicación', cap.date));
    } else if (f?.caption && String(f.caption).trim()) {
      body.append(el('p', 'cover-pick-hint', String(f.caption).slice(0, 800)));
    } else {
      body.append(el('p', 'cover-pick-hint', 'Sin datos en Telegram'));
    }

    // Fila inferior: [‹ anterior] [Ver descripción / Rellenar Ficha Telegram] [siguiente ›]
    const navRow = el('div', 'info-navrow');
    const mkNav = (txt, label) => {
      const b = el('button', 'btn info-nav-btn', txt);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.disabled = true;
      return b;
    };
    const prevBtn = mkNav('‹', 'Cómic anterior');
    const nextBtn = mkNav('›', 'Cómic siguiente');
    const mid = el('div', 'info-nav-mid');
    if (hasAnyFicha && cap.description) {
      const descBtn = el('button', 'btn cover-pick-device', 'Ver descripción');
      descBtn.type = 'button';
      descBtn.onclick = () => {
        frame.remove();
        showDescriptionPanel(cap.description);
      };
      mid.append(descBtn);
    }
    // Rellenar disponible si no hay ficha completa (p. ej. solo "Nombre de archivo")
    if (!hasExtraFicha) {
      const fillBtn = el('button', 'btn cover-pick-device', 'Rellenar Ficha Telegram');
      fillBtn.type = 'button';
      fillBtn.onclick = () => {
        frame.remove();
        // Al terminar (guardar, cancelar o cerrar) se vuelve a Información
        const back = () => showComicInfo(ch, f, displayTitle);
        showCaptionEditor(ch, f, back, { onClose: back });
      };
      mid.append(fillBtn);
    }
    if (ch && f) {
      navRow.append(prevBtn, mid, nextBtn);
      body.append(navRow);
      comicNeighbors(ch, f).then(({ prev, next }) => {
        const wire = (btn, target) => {
          if (!target) return;
          btn.disabled = false;
          btn.onclick = () => showComicInfo(ch, target, '');
        };
        wire(prevBtn, prev);
        wire(nextBtn, next);
        // Sin vecinos: no mostrar las flechas (deja solo los botones de acción)
        if (!prev && !next) { prevBtn.hidden = true; nextBtn.hidden = true; }
      }).catch(() => { prevBtn.hidden = true; nextBtn.hidden = true; });
    } else if (mid.childNodes.length) {
      body.append(mid);
    }
    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error('showComicInfo', err);
    appAlert('No se pudo mostrar la información: ' + (err?.message || err));
  }
}


/** Cómic anterior / siguiente dentro de su serie (o del canal si no tiene serie con más números). */
async function comicNeighbors(ch, f) {
  let files = [];
  try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) {}
  if (!Array.isArray(files) || !files.length) return { prev: null, next: null };
  let list = [];
  try {
    const groups = groupSeries(files, ch.name, seriesOverrideFor(ch));
    const g = groups.find((x) => x.files.some((y) => String(y.id) === String(f.id)));
    if (g) list = g.files;
  } catch (_) {}
  if (list.length < 2) {
    list = files.slice().sort((a, b) => natural(
      comicDisplay(comicSourceName(a), ch.name),
      comicDisplay(comicSourceName(b), ch.name)
    ));
  }
  const i = list.findIndex((x) => String(x.id) === String(f.id));
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? list[i - 1] : null, next: i < list.length - 1 ? list[i + 1] : null };
}

function existingSeriesLabels(ch, files) {
  const labels = new Set();
  for (const { label } of groupSeries(files || [], ch.name, seriesOverrideFor(ch))) {
    if (label) labels.add(label);
  }
  // Incluir overrides ya guardados
  try {
    const m = JSON.parse(localStorage.getItem('comicSeries:' + ch.id) || '{}');
    for (const v of Object.values(m || {})) if (v) labels.add(String(v));
  } catch (_) {}
  return [...labels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Editar título y serie del cómic (agrupa en la serie si existe) */

async function updateTelegramCaption(ch, f, caption) {
  if (!ch || !f?.id) return;
  const readyP = getReady();
  if (readyP && typeof readyP.then === 'function') await readyP;
  const client = getClient();
  if (!client) throw new Error('Cliente Telegram no listo');
  const peer = peerOf(ch);
  await client.invoke(new Api.messages.EditMessage({
    peer,
    id: Number(f.id),
    message: String(caption || ''),
  }));
  try {
    const files = (await kv.get('f:' + ch.id)) || [];
    const i = files.findIndex((x) => String(x.id) === String(f.id));
    if (i >= 0) {
      files[i] = { ...files[i], caption: String(caption || '') };
      await kv.set('f:' + ch.id, files);
    }
  } catch (_) {}
  f.caption = String(caption || '');
}


/** Formulario completo de ficha Telegram + Identificar (Comic Vine) */
function showCaptionEditor(ch, f, after, opts = {}) {
  document.querySelector('.info-frame.caption-editor')?.remove();
  const cap = parseComicCaption(f?.caption || '');
  const parsed = parseComicName(comicSourceName(f), ch?.name);
  const frame = el('div', 'info-frame caption-editor');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Ficha Telegram'));
  const close = el('button', 'btn info-close', '×');
  const closeEditor = () => {
    frame.remove();
    try { opts.onClose?.(); } catch (_) {}
  };
  close.onclick = closeEditor;
  head.append(close);
  const body = el('div', 'info-body');

  const idBtn = el('button', 'btn-identify', 'Identificar');
  idBtn.type = 'button';
  body.append(idBtn);
  body.append(el('p', 'cover-pick-hint', 'Busca en Comic Vine y rellena los campos.'));

  // Tras identificar: elegir qué campos de CV aplicar
  const selBar = el('div', 'meta-sel-bar');
  selBar.hidden = true;
  const btnAll = el('button', 'btn', 'Seleccionar todos');
  btnAll.type = 'button';
  const btnNone = el('button', 'btn', 'Ninguno');
  btnNone.type = 'button';
  selBar.append(btnAll, btnNone);
  body.append(selBar);
  body.append(el('p', 'cover-pick-hint meta-sel-hint', 'Marcado = dato de Comic Vine (editable). Sin marcar = valor anterior.'));
  const selHint = body.lastChild;
  selHint.hidden = true;

  const fieldCtrls = [];

  const mkField = (lab, prevVal, ph, multiline) => {
    const wrap = el('div', 'meta-field');
    const top = el('label', 'meta-field-top');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.className = 'meta-field-chk';
    chk.hidden = true;
    chk.checked = false;
    top.append(chk, document.createTextNode(' ' + lab));
    wrap.append(top);
    let inp;
    if (multiline) {
      inp = el('textarea', 'edit-input meta-desc meta-desc-lg');
      inp.rows = 14;
    } else {
      inp = el('input', 'edit-input');
      inp.type = 'text';
      inp.autocomplete = 'off';
    }
    const prev = prevVal != null ? String(prevVal) : '';
    inp.value = prev;
    if (ph) inp.placeholder = ph;
    wrap.append(inp);
    body.append(wrap);

    const ctrl = {
      chk, inp,
      prev,
      cv: '',
      apply() {
        if (chk.hidden) return;
        inp.value = chk.checked ? (ctrl.cv || '') : ctrl.prev;
      },
    };
    chk.onchange = () => ctrl.apply();
    fieldCtrls.push(ctrl);
    return ctrl;
  };

  // Si no hay dato en el caption de Telegram, rellenar con datos locales (archivo / canal / serie)
  const localSeries = (() => {
    try {
      const ov = getComicSeriesOverride?.(ch, f);
      if (ov != null && String(ov).trim()) return String(ov).trim();
    } catch (_) {}
    return parsed?.series || '';
  })();
  const localPublisher = (() => {
    try {
      const g = ch?.group;
      if (!g || g === 'Sin editorial') return '';
      return (typeof groupDisplayName === 'function' ? groupDisplayName(g) : g) || g;
    } catch (_) {
      return ch?.group && ch.group !== 'Sin editorial' ? ch.group : '';
    }
  })();

  // Título local (bbdd / nombre bajo portada) para restaurar al desmarcar CV
  const localTitleEs = (() => {
    if (cap.titleEs && String(cap.titleEs).trim()) {
      // Limpiar [Traducido] etc. para no dejar "#01 -"
      let t = String(cap.titleEs).trim()
        .replace(/\s*\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
        .trim();
      if (t) return t;
    }
    try {
      // Igual que el título que TGComic muestra bajo la portada en la serie: "#006 - Gothic (1 de 5)"
      // (sin el nombre de la serie). Un título personalizado por el usuario sigue ganando.
      if (parsed) {
        const issue = issueDisplay(parsed);
        let t = String(comicDisplayName(ch, f, issue) || issue || '').trim();
        if (t && !/^#/.test(t)) {
          const mh = t.match(/#\s*(.+)$/);
          t = mh ? ('#' + mh[1].replace(/^#\s*/, '').trim()) : issue;
        }
        if (t) return t;
      }
      const base = comicDisplay(comicSourceName(f), ch?.name) || '';
      const shown = comicDisplayName(ch, f, base);
      return (shown || base || '').trim();
    } catch (_) {
      if (opts.currentLabel && String(opts.currentLabel).trim()) return String(opts.currentLabel).trim();
      return '';
    }
  })();
  const localTitleOrig = (cap.originalTitle && String(cap.originalTitle).trim())
    ? String(cap.originalTitle).trim()
    : localTitleEs;

  const fileNameCtrl = mkField('Nombre de archivo', cap.fileName || (f?.name || ''));
  const titleEsCtrl = mkField('Título España', localTitleEs);
  const origCtrl = mkField('Título original', localTitleOrig);
  const seriesCtrl = mkField('Serie', cap.series || localSeries);
  const writerCtrl = mkField('Guionista', cap.writer, 'Nombre1 | Nombre2');
  const artistCtrl = mkField('Dibujante', cap.artist, 'Nombre1 | Nombre2');
  const pubCtrl = mkField('Editorial', cap.publisher || localPublisher);
  const dateCtrl = mkField('Fecha de publicación', cap.date, 'MM/AAAA o AAAA');
  const descCtrl = mkField('Descripción', cap.description || '', '', true);

  const setSelectMode = (on) => {
    selBar.hidden = !on;
    selHint.hidden = !on;
    for (const c of fieldCtrls) {
      c.chk.hidden = !on;
      if (!on) c.chk.checked = false;
    }
  };

  btnAll.onclick = () => {
    for (const c of fieldCtrls) {
      c.chk.checked = true;
      c.apply();
    }
  };
  btnNone.onclick = () => {
    for (const c of fieldCtrls) {
      c.chk.checked = false;
      c.apply();
    }
  };

  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = closeEditor;
  const save = el('button', 'btn edit-save', 'Guardar en Telegram');
  save.onclick = async () => {
    // Guardar lo que hay en los inputs (según checks ya aplicados)
    const caption = buildComicCaption({
      fileName: fileNameCtrl.inp.value,
      titleEs: titleEsCtrl.inp.value,
      originalTitle: origCtrl.inp.value,
      series: seriesCtrl.inp.value,
      writer: writerCtrl.inp.value,
      artist: artistCtrl.inp.value,
      publisher: pubCtrl.inp.value,
      date: dateCtrl.inp.value,
      description: descCtrl.inp.value,
    });
    if (caption.length > 1024) {
      appAlert('El caption tiene ' + caption.length + ' caracteres (máx. 1024). Acorta la descripción.');
      return;
    }
    try {
      save.disabled = true;
      await updateTelegramCaption(ch, f, caption);
      frame.remove();
      const editWasOpen = !!document.querySelector('.info-frame.edit-comic');
      document.querySelector('.info-frame.edit-comic')?.remove();
      document.querySelector('.info-frame.comic-info')?.remove();
      try { after?.(); } catch (_) {}
      try {
        const top = stack[stack.length - 1];
        if (top && !top._isComic && !document.getElementById('rd')) {
          top.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
          show();
        }
      } catch (_) {}
      if (editWasOpen || opts.reopenEdit) {
        showEditComicTitle(ch, f, opts.currentLabel || '', after);
      }
    } catch (e) {
      appAlert('No se pudo guardar el caption: ' + (e?.message || e));
    } finally {
      save.disabled = false;
    }
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);

  idBtn.onclick = () => showComicVinePicker(ch, f, {
    onPick: (detail) => {
      if (!detail) return;
      const num = String(detail.issueNumber || '').replace(/^#/, '').trim();
      const story = String(detail.name || '').trim();
      let titleLine = '';
      if (num && story) titleLine = '#' + num + ' - ' + story;
      else if (num) titleLine = '#' + num;
      else titleLine = story;

      // Valores CV por campo (nombre de archivo no viene de CV → dejar vacío = no forzar)
      titleEsCtrl.cv = titleLine;
      origCtrl.cv = titleLine;
      seriesCtrl.cv = detail.volume || '';
      writerCtrl.cv = (detail.writers && detail.writers.length) ? detail.writers.join(' | ') : '';
      artistCtrl.cv = (detail.artists && detail.artists.length) ? detail.artists.join(' | ') : '';
      pubCtrl.cv = detail.publisher || '';
      dateCtrl.cv = detail.coverDate || '';
      descCtrl.cv = detail.description || '';
      fileNameCtrl.cv = fileNameCtrl.prev; // no cambia por CV

      setSelectMode(true);
      // Por defecto: marcar los que CV aportó dato, salvo Editorial, Serie y Título España,
      // que vienen desmarcados con el valor local (parseo del nombre / lo ya configurado en TGComic).
      const keepLocal = new Set([pubCtrl, seriesCtrl, titleEsCtrl]);
      for (const c of fieldCtrls) {
        const hasCv = (c === fileNameCtrl || keepLocal.has(c)) ? false : !!(c.cv && String(c.cv).trim());
        c.chk.checked = hasCv;
        c.apply();
      }
    },
  });
}

function showComicVinePicker(ch, f, { onPick, series, number, query, fileName, channelName } = {}) {
  document.querySelector('.info-frame.cv-picker')?.remove();
  const frame = el('div', 'info-frame cv-picker');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Identificar (Comic Vine)'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');

  // Cargar un número directamente desde su URL de Comic Vine
  const urlInp = el('input', 'edit-input cv-url-input');
  urlInp.type = 'text';
  urlInp.autocomplete = 'off';
  urlInp.spellcheck = false;
  urlInp.placeholder = 'https://comicvine.gamespot.com/…/4000-123456/';
  body.append(urlInp);
  const urlBtn = el('button', 'btn edit-save cv-url-btn', 'Url de Comic Vine');
  urlBtn.type = 'button';
  body.append(urlBtn);
  const urlStatus = el('p', 'sync-status', '');
  body.append(urlStatus);
  const loadFromUrl = async () => {
    const raw = urlInp.value.trim();
    urlStatus.className = 'sync-status';
    if (!raw) { urlStatus.textContent = 'Pega la URL de un número de Comic Vine'; return; }
    if (!comicVineConfigured()) {
      urlStatus.textContent = 'Comic Vine no está configurado.';
      urlStatus.className = 'sync-status sync-err';
      return;
    }
    const mIssue = raw.match(/(?:^|[/-])4000-(\d+)/) || raw.match(/\/api\/issue\/4000-(\d+)/i);
    const bare = raw.match(/^\d+$/);
    const id = mIssue ? mIssue[1] : (bare ? bare[0] : '');
    if (!id) {
      urlStatus.textContent = /4050-\d+/.test(raw)
        ? 'Esa URL es de una colección (volumen). Usa la URL de un número concreto (contiene 4000-…).'
        : 'No reconozco la URL. Debe ser la de un número de Comic Vine (contiene 4000-…).';
      urlStatus.className = 'sync-status sync-err';
      return;
    }
    urlBtn.disabled = true;
    urlStatus.textContent = 'Cargando ficha…';
    try {
      const detail = await fetchIssueDetail(id);
      if (!detail) throw new Error('No se encontró ese número en Comic Vine');
      frame.remove();
      onPick?.(detail);
    } catch (e) {
      urlStatus.textContent = 'Error: ' + (e?.message || e);
      urlStatus.className = 'sync-status sync-err';
    } finally {
      urlBtn.disabled = false;
    }
  };
  urlBtn.onclick = () => loadFromUrl();
  urlInp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); loadFromUrl(); }
  });

  // Contexto: cómic existente (ch/f) o datos de subida (opts series/number/…)
  const chName = (channelName != null && String(channelName).trim())
    ? String(channelName).trim()
    : (ch?.name || '');
  const fname = (fileName != null && String(fileName).trim())
    ? String(fileName).trim()
    : (f?.name || '');
  let parsed = null;
  try {
    if (f || fname) parsed = parseComicName(
      f ? comicSourceName(f) : fname,
      chName
    );
  } catch (_) {}
  const cap = parseComicCaption(f?.caption || '');
  const seriesForQ = (series != null && String(series).trim())
    ? String(series).trim()
    : (cap.series || parsed?.series || seriesBase(fname, chName) || '');
  const numberForQ = (number != null && String(number).trim())
    ? String(number).replace(/^#/, '').trim()
    : (parsed?.number || '');
  const qDefault = (query != null && String(query).trim())
    ? String(query).trim()
    : buildSearchQuery({
        channel: chName,
        series: seriesForQ,
        number: numberForQ,
        fileName: fname,
      });

  body.append(el('label', 'sync-label', 'Búsqueda'));
  const qInp = el('input', 'edit-input');
  qInp.type = 'text';
  qInp.value = qDefault;
  body.append(qInp);
  const searchBtn = el('button', 'btn edit-save', 'Buscar');
  searchBtn.type = 'button';
  body.append(searchBtn);
  const status = el('p', 'sync-status', '');
  body.append(status);
  const list = el('div', 'cv-results');
  body.append(list);

  const runSearch = async () => {
    list.replaceChildren();
    if (!comicVineConfigured()) {
      status.textContent = 'Configura VITE_COMICVINE_API_KEY en Vercel (.env).';
      status.className = 'sync-status sync-err';
      return;
    }
    const q = qInp.value.trim();
    if (!q) {
      status.textContent = 'Escribe algo para buscar';
      return;
    }
    searchBtn.disabled = true;
    status.className = 'sync-status';
    status.textContent = 'Buscando en Comic Vine…';
    try {
      const seriesQ = (cap.series || parsed?.series || seriesBase(f?.name || '', ch?.name) || '').trim();
      const numberQ = String(parsed?.number || '').replace(/^#/, '').trim();
      const results = await searchIssuesSmart({
        query: q,
        series: seriesQ,
        number: numberQ,
      });
      status.textContent = results.length
        ? (results.length + ' resultados (búsqueda ampliada)')
        : 'Sin resultados — prueba a quitar el canal o el número en la caja de texto';
      for (const r of results) {
        const btn = el('button', 'cv-result');
        btn.type = 'button';
        const title = [r.volume, r.issueNumber ? ('#' + r.issueNumber) : '', r.name].filter(Boolean).join(' ');
        btn.append(el('b', '', title || ('Issue ' + r.id)));
        const sub = [];
        if (r.coverDate) sub.push(r.coverDate);
        if (r.volume) sub.push(r.volume);
        if (sub.length) btn.append(el('span', 'cv-sub', sub.join(' · ')));
        btn.append(el('span', 'cv-pages',
          r.publisher ? ('Editorial: ' + r.publisher) : 'Editorial: —'
        ));
        btn.onclick = async () => {
          btn.disabled = true;
          status.textContent = 'Cargando ficha…';
          try {
            let detail = null;
            if (r.apiDetailUrl) detail = await fetchIssueDetail(r.apiDetailUrl);
            else detail = await fetchIssueDetail(r.id);
            if (!detail) {
              detail = {
                name: r.name,
                issueNumber: r.issueNumber,
                volume: r.volume,
                coverDate: r.coverDate,
                publisher: r.publisher || '',
                writers: [],
                artists: [],
                description: '',
              };
            } else {
              // Preferir número/nombre del resultado de la lista si el detalle los trae vacíos
              if (!detail.issueNumber && r.issueNumber) detail.issueNumber = r.issueNumber;
              if (!detail.name && r.name) detail.name = r.name;
              if (!detail.volume && r.volume) detail.volume = r.volume;
              if (!detail.publisher && r.publisher) detail.publisher = r.publisher;
              // Si el detalle trae name vacío pero sí número, no dejar títulos distintos
              if (r.issueNumber && !detail.issueNumber) detail.issueNumber = r.issueNumber;
            }
            frame.remove();
            onPick?.(detail);
          } catch (e) {
            status.textContent = 'Error: ' + (e?.message || e);
            status.className = 'sync-status sync-err';
            btn.disabled = false;
          }
        };
        list.append(btn);
      }
    } catch (e) {
      status.textContent = 'Error: ' + (e?.message || e);
      status.className = 'sync-status sync-err';
    } finally {
      searchBtn.disabled = false;
    }
  };

  searchBtn.onclick = () => runSearch();
  qInp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); runSearch(); }
  });

  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
  // Sin búsqueda automática: el usuario revisa la consulta y pulsa «Buscar»
}

function showEditComicTitle(ch, f, currentLabel, after) {
  document.querySelector('.info-frame.edit-comic')?.remove();
  const fallbackTitle = comicDisplay(comicSourceName(f), ch?.name) || clean(f?.name || '') || '';
  const currentTitle = comicDisplayName(ch, f, currentLabel || fallbackTitle);
  const parsed = parseComicName(comicSourceName(f), ch?.name);
  const parsedSeries = (parsed?.series || seriesBase(f?.name || '', ch?.name) || '').trim();
  const overrideRaw = getComicSeriesOverride(ch, f);
  // Clave real de agrupación
  const seriesKey = (overrideRaw != null && String(overrideRaw).trim())
    ? String(overrideRaw).trim()
    : parsedSeries;

  const frame = el('div', 'info-frame edit-comic');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar datos del comic'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');

  body.append(el('div', 'info-sec', 'Título'));
  const inputTitle = el('input', 'edit-input');
  inputTitle.type = 'text';
  inputTitle.value = currentTitle;
  inputTitle.autocomplete = 'off';
  inputTitle.placeholder = 'Título visible';
  body.append(inputTitle);
  body.append(el('p', 'cover-pick-hint', 'Vacío = restaurar el del nombre de archivo.'));

  body.append(el('div', 'info-sec', 'Serie'));
  const seriesSel = el('select', 'edit-input series-select');
  const seriesOther = el('input', 'edit-input');
  seriesOther.type = 'text';
  seriesOther.autocomplete = 'off';
  seriesOther.placeholder = 'Nombre de la nueva serie';
  seriesOther.hidden = true;
  body.append(seriesSel);
  body.append(seriesOther);
  body.append(el('p', 'cover-pick-hint', 'Elige una serie del canal o «Otra…». Vacío / original = sin forzar agrupación.'));

  // Rellenar desplegable
  (async () => {
    try {
      let files = (await kv.get('f:' + ch.id)) || [];
      if (!files.length) {
        try { files = await fetchFiles(ch); } catch (_) {}
      }
      const labels = existingSeriesLabels(ch, files);
      seriesSel.replaceChildren();

      const optOrig = el('option');
      optOrig.value = '';
      optOrig.textContent = parsedSeries
        ? ('Original del archivo: ' + parsedSeries)
        : 'Original del archivo (sin serie)';
      seriesSel.append(optOrig);

      const seen = new Set();
      if (parsedSeries) seen.add(parsedSeries.toLowerCase());

      for (const lab of labels) {
        const k = String(lab).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const o = el('option');
        o.value = lab;
        const shown = seriesDisplayName(ch, lab);
        o.textContent = (shown && shown !== lab) ? (shown + ' (' + lab + ')') : lab;
        seriesSel.append(o);
      }

      // Si la clave actual no está en la lista (serie forzada rara), añadirla
      if (seriesKey && !seen.has(seriesKey.toLowerCase())
          && seriesKey.toLowerCase() !== parsedSeries.toLowerCase()) {
        const o = el('option');
        o.value = seriesKey;
        o.textContent = seriesKey;
        seriesSel.append(o);
      }

      const optOther = el('option');
      optOther.value = '__other__';
      optOther.textContent = 'Otra…';
      seriesSel.append(optOther);

      // Selección inicial
      if (!overrideRaw) {
        seriesSel.value = '';
        seriesOther.hidden = true;
      } else if ([...seriesSel.options].some((o) => o.value === seriesKey)) {
        seriesSel.value = seriesKey;
        seriesOther.hidden = true;
      } else {
        seriesSel.value = '__other__';
        seriesOther.hidden = false;
        seriesOther.value = seriesKey;
      }
    } catch (e) {
      console.warn('[series select]', e);
      const o = el('option');
      o.value = '';
      o.textContent = 'Original';
      seriesSel.append(o);
    }
  })();

  seriesSel.onchange = () => {
    if (seriesSel.value === '__other__') {
      seriesOther.hidden = false;
      seriesOther.focus();
    } else {
      seriesOther.hidden = true;
      seriesOther.value = '';
    }
  };

  const fichaBtn = el('button', 'btn cover-pick-device', 'Ficha Telegram');
  fichaBtn.type = 'button';
  fichaBtn.onclick = () => {
    showCaptionEditor(ch, f, after, { reopenEdit: true, currentLabel: currentLabel || currentTitle });
  };
  body.append(fichaBtn);

  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = async () => {
    const titleV = inputTitle.value.trim();
    let titleSave = titleV;
    if (titleSave && ch.name) {
      try {
        const esc = ch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        titleSave = titleSave.replace(new RegExp('^' + esc + '\\s*-\\s*', 'i'), '').trim();
      } catch (_) {}
    }
    // Vacío = restaurar automático. Cualquier otro texto se guarda tal cual
    // (antes se descartaba si se parecía al título del archivo/caption y no persistía).
    if (!titleSave) titleSave = '';

    // Serie desde el <select>
    let seriesSave = '';
    const sel = seriesSel.value;
    if (sel === '__other__') {
      const custom = seriesOther.value.trim();
      if (!custom) seriesSave = '';
      else if (parsedSeries && custom.toLowerCase() === parsedSeries.toLowerCase()) seriesSave = '';
      else seriesSave = custom;
    } else if (!sel) {
      seriesSave = ''; // original
    } else if (parsedSeries && sel.toLowerCase() === parsedSeries.toLowerCase()) {
      seriesSave = '';
    } else {
      seriesSave = sel;
    }

    setComicDisplayName(ch, f, titleSave, () => {
      setComicSeries(ch, f, seriesSave, () => {
        frame.remove();
        after?.();
      });
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
  setTimeout(() => { inputTitle.focus(); inputTitle.select(); }, 50);
}


function showSeriesInfo(ch, seriesLabel, files) {
  try {
    document.querySelector('.info-frame.series-info')?.remove();
    const display = seriesDisplayName(ch, seriesLabel);
    const n = files?.length || 0;
    let bytes = 0;
    for (const f of files || []) bytes += Number(f.size) || 0;
    const frame = el('div', 'info-frame series-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    const titleSpan = el('span', 'info-head-title', 'Información');
    titleSpan.title = 'Pulsa para copiar';
    head.append(titleSpan);
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    titleSpan.onclick = (ev) => {
      ev.stopPropagation();
      copyInfoFrameText(body);
      titleSpan.textContent = 'Copiado';
      setTimeout(() => { titleSpan.textContent = 'Información'; }, 1200);
    };
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Serie'));
    body.append(row('Nombre', display));
    if (display !== seriesLabel) body.append(row('Nombre original', seriesLabel));
    body.append(row('Canal', ch ? channelDisplayName(ch) : '—'));
    body.append(row('Editorial', ch?.group || '—'));
    body.append(row('Números', String(n)));
    body.append(row('Tamaño total', formatBytes(bytes)));

    // Cómics con algún campo CV/editorial/descripción vacío
    const pending = (files || []).filter((f) => comicNeedsCvFill(f, ch));
    if (pending.length && typeof comicVineConfigured === 'function' && comicVineConfigured()) {
      const fillBtn = el('button', 'btn cover-pick-device', 'Rellenar fichas (Comic Vine)');
      fillBtn.type = 'button';
      fillBtn.style.marginTop = '0.75rem';
      fillBtn.onclick = () => {
        frame.remove();
        showSeriesCvFillForm(ch, seriesLabel, files || []);
      };
      body.append(fillBtn);
      body.append(el('p', 'cover-pick-hint',
        pending.length + ' número(s) con campos vacíos (título original, créditos, fecha, descripción o editorial). Solo se rellenan los que falten.'
      ));
    } else if (pending.length && typeof comicVineConfigured === 'function' && !comicVineConfigured()) {
      body.append(el('p', 'cover-pick-hint', 'Comic Vine no configurado (falta API key).'));
    }

    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error(err);
    appAlert('No se pudo mostrar la información');
  }
}

/** Editorial local (BBDD / canal), no Comic Vine. */
function localPublisherOf(ch) {
  try {
    const g = ch?.group;
    if (!g || g === 'Sin editorial') return '';
    return (typeof groupDisplayName === 'function' ? groupDisplayName(g) : g) || g;
  } catch (_) {
    return ch?.group && ch.group !== 'Sin editorial' ? ch.group : '';
  }
}

/** True si falta algún campo que podemos rellenar (CV + editorial local). */
function comicNeedsCvFill(f, ch) {
  const cap = parseComicCaption(f?.caption || '');
  if (!String(cap.originalTitle || '').trim()) return true;
  if (!String(cap.writer || '').trim()) return true;
  if (!String(cap.artist || '').trim()) return true;
  if (!String(cap.date || '').trim()) return true;
  if (!String(cap.description || '').trim()) return true;
  if (!String(cap.publisher || '').trim() && localPublisherOf(ch)) return true;
  return false;
}

function normIssueKey(n) {
  let s = String(n || '').replace(/^#/, '').trim().toLowerCase();
  if (!s) return '';
  // "6.0" / "6.00" → "6"
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  const stripped = s.replace(/^0+(?=\d)/, '');
  return stripped || s;
}

/**
 * Formulario: URL de serie/volumen Comic Vine → rellena solo
 * Título original, Guionista, Dibujante, Fecha (resto desde archivo).
 * No toca cómics que ya tengan esos campos.
 */
function showSeriesCvFillForm(ch, seriesLabel, files) {
  document.querySelector('.info-frame.series-cv-fill')?.remove();
  const display = seriesDisplayName(ch, seriesLabel);
  const frame = el('div', 'info-frame series-cv-fill');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Rellenar serie (Comic Vine)'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('p', 'cover-pick-hint',
    'Serie: ' + display + '. Pega la URL del volumen en Comic Vine. Se rellenan solo los campos vacíos: Título original, Guionista, Dibujante, Fecha y Descripción (Comic Vine); Editorial desde la editorial del canal en TGComic. Nombre de archivo, Título España y Serie salen del archivo / serie local. Lo que ya esté relleno no se sobrescribe.'
  ));
  body.append(el('label', 'sync-label', 'URL de la serie (Comic Vine)'));
  const urlInp = el('input', 'edit-input');
  urlInp.type = 'url';
  urlInp.placeholder = 'https://comicvine.gamespot.com/…/4050-4200/';
  urlInp.autocomplete = 'off';
  body.append(urlInp);
  body.append(el('p', 'cover-pick-hint', 'Ejemplo: https://comicvine.gamespot.com/legends-of-the-dark-knight/4050-4200/'));

  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => {
    frame.remove();
    showSeriesInfo(ch, seriesLabel, files);
  };
  const goBtn = el('button', 'btn edit-save', 'Rellenar');
  goBtn.type = 'button';
  goBtn.onclick = async () => {
    const url = String(urlInp.value || '').trim();
    if (!url) {
      await appAlert('Pega la URL del volumen en Comic Vine.');
      return;
    }
    const volId = (typeof parseVolumeIdFromUrl === 'function' ? parseVolumeIdFromUrl(url) : '')
      || (url.match(/4050-(\d+)/i) || [])[1]
      || '';
    if (!volId) {
      await appAlert('No se reconoce un id de volumen (4050-…) en esa URL.');
      return;
    }
    if (typeof comicVineConfigured === 'function' && !comicVineConfigured()) {
      await appAlert('Falta VITE_COMICVINE_API_KEY.');
      return;
    }
    frame.remove();
    await runSeriesCvFill(ch, seriesLabel, files, volId, url);
  };
  actions.append(cancel, goBtn);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
  setTimeout(() => { try { urlInp.focus(); } catch (_) {} }, 50);
}


function floodWaitSeconds(err) {
  const msg = String(err?.message || err || '');
  const m = msg.match(/wait of (\d+)\s*seconds/i) || msg.match(/FLOOD_WAIT[_:]?\s*(\d+)/i);
  if (m) return Math.min(600, Math.max(1, parseInt(m[1], 10) || 0));
  return 0;
}

async function sleepSec(total, onTick) {
  const end = Date.now() + total * 1000;
  while (Date.now() < end) {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    try { onTick?.(left); } catch (_) {}
    await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
  }
}

/** EditMessage respetando FLOOD_WAIT de Telegram (espera y reintenta). */
async function editCaptionWithFloodWait(ch, f, caption, onStatus) {
  let attempt = 0;
  while (attempt < 4) {
    attempt++;
    try {
      await updateTelegramCaption(ch, f, caption);
      return;
    } catch (e) {
      const msg = String(e?.message || e || '');
      // Mismo texto que ya tenía → OK (no es fallo)
      if (/MESSAGE_NOT_MODIFIED/i.test(msg)) return;
      const w = floodWaitSeconds(e);
      if (w > 0) {
        try { onStatus?.('Telegram FLOOD_WAIT: esperando ' + w + 's…'); } catch (_) {}
        await sleepSec(w + 1, (left) => {
          try { onStatus?.('Esperando Telegram… ' + left + 's'); } catch (_) {}
        });
        continue;
      }
      // Otros errores: un reintento corto
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw e;
    }
  }
}

async function runSeriesCvFill(ch, seriesLabel, files, volId, sourceUrl) {
  const progFrame = el('div', 'info-frame series-cv-prog');
  const progBox = el('div', 'info-box');
  const progHead = el('div', 'info-head');
  progHead.append(el('span', '', 'Rellenando fichas'));
  progBox.append(progHead);
  const progBody = el('div', 'info-body');
  const status = el('p', 'cover-pick-hint', 'Consultando Comic Vine…');
  const bar = el('div', 'repack-panel-bar');
  const fill = el('div', 'repack-panel-fill');
  fill.style.width = '0%';
  bar.append(fill);
  const count = el('p', 'cover-pick-hint', '');
  progBody.append(status, bar, count);
  progBox.append(progBody);
  progFrame.append(progBox);
  document.body.append(progFrame);

  const setProg = (done, total, msg) => {
    if (msg) status.textContent = msg;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    fill.style.width = pct + '%';
    count.textContent = total ? `${done} / ${total} (${pct}%)` : '';
  };

  try {
    const listFn = typeof listAllIssuesForVolume === 'function'
      ? listAllIssuesForVolume
      : (typeof listIssuesForVolume === 'function' ? (id) => listIssuesForVolume(id, null, 100) : null);
    if (!listFn) throw new Error('listAllIssuesForVolume no disponible');

    status.textContent = 'Listando números del volumen…';
    const issues = await listFn(volId);
    if (!issues.length) throw new Error('Comic Vine no devolvió números para ese volumen.');

    // Índice por número normalizado
    const byNum = new Map();
    for (const iss of issues) {
      const k = normIssueKey(iss.issueNumber);
      if (!k) continue;
      if (!byNum.has(k)) byNum.set(k, iss);
    }

    const targets = (files || []).filter((f) => comicNeedsCvFill(f, ch));
    if (!targets.length) {
      progFrame.remove();
      await appAlert('Ningún cómic de la serie necesita relleno (todos los campos cubiertos).');
      showSeriesInfo(ch, seriesLabel, files);
      return;
    }

    let ok = 0, skip = 0, fail = 0, noMatch = 0;
    const failSamples = [];
    setProg(0, targets.length, 'Emparejando y guardando…');

    /** Nombre legible: caption "Nombre de archivo" si existe; si no, comicSourceName. */
    const sourceNameOf = (f) => {
      try {
        const capFn = String(parseComicCaption(f?.caption || '').fileName || '').trim();
        if (capFn) return capFn;
      } catch (_) {}
      try { return comicSourceName(f) || f?.name || ''; } catch (_) { return f?.name || ''; }
    };
    const numKeyOf = (f) => {
      const src = sourceNameOf(f);
      const parsed = parseComicName(src, ch?.name);
      if (parsed?.number) return { key: normIssueKey(parsed.number), parsed, src };
      const m = String(src).match(/#\s*([0-9]+(?:\.[0-9]+)?[a-zA-Z]?)/i);
      if (m) return { key: normIssueKey(m[1]), parsed: parsed || { number: m[1], series: seriesLabel }, src };
      return { key: '', parsed, src };
    };
    const keep = (prev, next) => {
      const p = String(prev || '').trim();
      if (p) return p;
      return String(next || '').trim();
    };
    const fitCaption = (fields) => {
      let caption = buildComicCaption(fields);
      if (caption.length <= 1024) return caption;
      // Acortar descripción de forma agresiva
      let desc = String(fields.description || '');
      const overhead = caption.length - desc.length;
      const budget = Math.max(0, 1000 - overhead);
      fields.description = desc.slice(0, budget);
      caption = buildComicCaption(fields);
      if (caption.length <= 1024) return caption;
      fields.description = '';
      caption = buildComicCaption(fields);
      return caption.length > 1024 ? caption.slice(0, 1024) : caption;
    };

    for (let i = 0; i < targets.length; i++) {
      const f = targets[i];
      setProg(i, targets.length, (f.name || '').slice(0, 48));
      try {
        const { key: numKey, parsed, src } = numKeyOf(f);
        if (!numKey) { noMatch++; continue; }
        const iss = byNum.get(numKey);
        if (!iss) { noMatch++; continue; }

        const capPrev = parseComicCaption(f?.caption || '');
        const needCredits = !String(capPrev.writer || '').trim() || !String(capPrev.artist || '').trim();
        const needDesc = !String(capPrev.description || '').trim();

        // Solo pedir detalle si faltan créditos o descripción (evita rate-limit CV)
        let detail = null;
        if ((needCredits || needDesc) && typeof fetchIssueDetail === 'function') {
          try {
            const ref = iss.apiDetailUrl || iss.id;
            if (ref) detail = await fetchIssueDetail(ref);
          } catch (e) {
            console.warn('[series-cv] detail', f?.name, e?.message || e);
          }
        }

        const story = String((detail && detail.name) || iss.name || '').trim();
        const num = String((detail && detail.issueNumber) || iss.issueNumber || parsed?.number || numKey).replace(/^#/, '').trim();
        let cvTitle = '';
        if (num && story) cvTitle = '#' + num + ' - ' + story;
        else if (num) cvTitle = '#' + num;
        else cvTitle = story;

        const writers = (detail && detail.writers && detail.writers.length)
          ? detail.writers.join(' | ')
          : '';
        const artists = (detail && detail.artists && detail.artists.length)
          ? detail.artists.join(' | ')
          : '';
        let cvDate = (detail && detail.coverDate) || '';
        if (!cvDate && iss.coverDate) {
          const dm = String(iss.coverDate).match(/^(\d{4})-(\d{2})/);
          cvDate = dm ? (dm[2] + '/' + dm[1]) : String(iss.coverDate).slice(0, 4);
        }
        let cvDesc = String((detail && detail.description) || '').trim();
        if (cvDesc.length > 600) cvDesc = cvDesc.slice(0, 600) + '…';

        const issueLab = parsed ? issueDisplay(parsed) : (num ? ('#' + num) : '');
        let titleEs = (capPrev.titleEs && String(capPrev.titleEs).trim()) || issueLab || '';
        if (titleEs && !/^#/.test(titleEs.trim()) && issueLab) titleEs = issueLab;

        // Nombre de archivo legible: caption > sourceName > f.name
        const niceFile = String(capPrev.fileName || src || f.name || '').trim();

        const localPub = localPublisherOf(ch);
        const fields = {
          fileName: niceFile,
          titleEs,
          originalTitle: keep(capPrev.originalTitle, cvTitle),
          series: keep(capPrev.series, seriesLabel || parsed?.series || ''),
          writer: keep(capPrev.writer, writers),
          artist: keep(capPrev.artist, artists),
          publisher: keep(capPrev.publisher, localPub),
          date: keep(capPrev.date, cvDate),
          description: keep(capPrev.description, cvDesc),
        };

        const caption = fitCaption(fields);
        await editCaptionWithFloodWait(ch, f, caption, (msg) => {
          status.textContent = msg;
        });
        ok++;
        // Ritmo conservador: ~1 edición / 1.2 s para no reactivar FLOOD_WAIT
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.warn('[series-cv]', f?.name, e);
        fail++;
        if (failSamples.length < 5) {
          failSamples.push((f?.name || '?').slice(0, 40) + ': ' + (e?.message || e));
        }
        // Si el error trae otra espera, respetarla antes de seguir
        const w = floodWaitSeconds(e);
        if (w > 0) {
          status.textContent = 'Telegram pide esperar ' + w + 's…';
          await sleepSec(w + 1, (left) => {
            status.textContent = 'Esperando Telegram… ' + left + 's';
          });
        }
      }
      setProg(i + 1, targets.length, (f.name || '').slice(0, 48));
    }

    progFrame.remove();
    const parts = [
      `Actualizados: ${ok}`,
      noMatch ? `Sin match de número: ${noMatch}` : '',
      fail ? `Fallos: ${fail}` : '',
      skip ? `Omitidos: ${skip}` : '',
    ].filter(Boolean);
    if (failSamples.length) parts.push('Ejemplos:\n' + failSamples.join('\n'));
    await appAlert(parts.join('\n'), 'Comic Vine');
    // Refrescar listado en memoria si hace falta
    try {
      const top = stack?.[stack.length - 1];
      if (top && !document.getElementById('rd')) {
        top.scrollY = window.scrollY || 0;
        show?.();
      }
    } catch (_) {}
    showSeriesInfo(ch, seriesLabel, files);
  } catch (e) {
    try { progFrame.remove(); } catch (_) {}
    await appAlert('Error: ' + (e?.message || e), 'Comic Vine');
    showSeriesInfo(ch, seriesLabel, files);
  }
}


/** Primera portada de cómic disponible (prueba varios si el 1º falla, p.ej. CBR sin abrir). */
async function firstAvailableCover(ch, files) {
  let list = Array.isArray(files) ? files : [];
  if (!list.length && ch?.id) {
    try {
      list = (await kv.get('f:' + ch.id)) || [];
    } catch (_) { list = []; }
  }
  if (!list.length && ch?.id) {
    try { list = await fetchFiles(ch); } catch (_) { list = []; }
  }
  for (const f of list) {
    if (!f?.id) continue;
    try {
      const b = await getCover(ch, f);
      if (b instanceof Blob && b.size) return b;
    } catch (_) {}
  }
  return null;
}

async function getSeriesCoverBlob(ch, seriesLabel, files) {
  try {
    const b = await kv.get(seriesCoverKey(ch, seriesLabel));
    if (b instanceof Blob && b.size) return b;
  } catch (_) {}
  // Generar desde el primer cómic y GUARDAR en caché (evita re-descargas)
  const generated = await firstAvailableCover(ch, files);
  if (generated instanceof Blob && generated.size) {
    try { await setSeriesCoverBlob(ch, seriesLabel, generated); } catch (_) {}
    try {
      const cached = await kv.get(seriesCoverKey(ch, seriesLabel));
      if (cached instanceof Blob && cached.size) return cached;
    } catch (_) {}
    return generated;
  }
  return null;
}
async function setSeriesCoverBlob(ch, seriesLabel, blob) {
  if (!blob) return;
  try {
    const opt = await optimizeImageBlob(blob, 320, 0.75);
    await kv.set(seriesCoverKey(ch, seriesLabel), opt || blob);
  } catch (e) {
    console.warn('series cover', e);
    try { await kv.set(seriesCoverKey(ch, seriesLabel), blob); } catch (_) {}
  }
}
function seriesReadProgress(ch, files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  let done = 0;
  for (const f of list) {
    if (isComicRead(ch.id, f.id)) done++;
  }
  if (done === 0) return null;
  const pct = Math.round((done / list.length) * 100);
  return { done, tot: list.length, pct };
}

function seriesCoverNode(ch, seriesLabel, files, badge) {
  const d = el('div', 'cover cover-series'), ltr = el('span', '', (seriesDisplayName(ch, seriesLabel) || seriesLabel || '?').slice(0, 1).toUpperCase());
  d.append(ltr);
  if (badge != null && badge !== '') {
    d.append(el('span', 'badge series', String(badge)));
  }
  // Progreso de lectura de la serie (como en cómics)
  const sprog = seriesReadProgress(ch, files);
  if (sprog) {
    const bar = el('div', 'prog');
    const fill = el('div', 'prog-fill');
    fill.style.width = sprog.pct + '%';
    bar.append(fill);
    d.append(bar);
    const pb = el('span', 'prog-badge', sprog.pct >= 95 ? '✓' : sprog.pct + '%');
    d.append(pb);
  }
  d._load = async () => {
    const b = await getSeriesCoverBlob(ch, seriesLabel, files);
    if (!b) return;
    const img = new Image();
    img.onload = () => {
      try { ltr.remove(); } catch (_) {}
      try {
        if (img.naturalWidth > img.naturalHeight) d.classList.add('landscape');
        else d.classList.remove('landscape');
      } catch (_) {}
      d.prepend(img);
    };
    setBlobImg(img, b, d);
  };
  io.observe(d);
  return d;
}
/** Submenú Editar serie */
function showEditSeries(ch, seriesLabel, files, after) {
  const title = seriesDisplayName(ch, seriesLabel);
  const list = Array.isArray(files) ? files : [];
  sheet(title, [
    ['Editar nombre de la serie a la que pertenece', () => showEditSeriesName(ch, seriesLabel, list, after)],
    ['Seleccionar portada de la serie', () => showSeriesCoverPicker(ch, seriesLabel, list, after)],
  ]);
}
function showEditSeriesName(ch, seriesLabel, seriesFiles, after) {
  document.querySelector('.info-frame.edit-series')?.remove();
  // Valor que ve el usuario: override real de los cómics o renombre visual o la clave
  const current = seriesDisplayName(ch, seriesLabel) || seriesLabel || '';
  const frame = el('div', 'info-frame edit-series');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar nombre de la serie'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', 'Nombre de la serie'));
  const input = el('input', 'edit-input');
  input.type = 'text';
  input.value = current;
  input.autocomplete = 'off';
  body.append(input);
  body.append(el('p', 'cover-pick-hint',
    'Se aplica a todos los cómics de esta serie. Si el nombre ya existe, se fusionan.'
  ));
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = async () => {
    const newName = input.value.trim();
    try {
      let allFiles = (await kv.get('f:' + ch.id)) || [];
      if (!allFiles.length) {
        try { allFiles = await fetchFiles(ch); } catch (_) {}
      }
      // Miembros de la serie (lista pasada o por clave/override)
      let members = Array.isArray(seriesFiles) && seriesFiles.length ? seriesFiles.slice() : [];
      if (!members.length) {
        for (const f of allFiles) {
          const ov = getComicSeriesOverride(ch, f);
          const p = parseComicName(comicSourceName(f), ch.name);
          const base = (ov != null && String(ov).trim())
            ? String(ov).trim()
            : (p?.series || seriesBase(f.name, ch.name) || '');
          if (String(base).toLowerCase() === String(seriesLabel).toLowerCase()) members.push(f);
        }
      }
      if (!members.length) {
        appAlert('No se encontraron cómics de esta serie');
        return;
      }

      // ¿Fusionar con una serie ya existente (otra clave)?
      const labels = existingSeriesLabels(ch, allFiles);
      const hit = newName
        ? labels.find((lab) =>
            lab.toLowerCase() !== String(seriesLabel).toLowerCase()
            && lab.toLowerCase() === newName.toLowerCase()
          )
        : null;
      const target = hit || newName;

      // UN solo mecanismo: override por cómic (no renombre visual)
      for (const f of members) {
        const p = parseComicName(comicSourceName(f), ch.name);
        const parsedSer = (p?.series || seriesBase(f.name, ch.name) || '').trim();
        if (!target || (parsedSer && target.toLowerCase() === parsedSer.toLowerCase())) {
          setComicSeries(ch, f, ''); // vuelve al nombre del archivo
        } else {
          setComicSeries(ch, f, target);
        }
      }
      // Limpiar renombres visuales viejos para no liar el campo
      try { setSeriesDisplayName(ch, seriesLabel, ''); } catch (_) {}
      if (target && target.toLowerCase() !== String(seriesLabel).toLowerCase()) {
        try { setSeriesDisplayName(ch, target, ''); } catch (_) {}
      }
    } catch (e) {
      console.error('[series rename]', e);
      appAlert('Error al guardar la serie: ' + (e?.message || e));
      return;
    }
    frame.remove();
    after?.();
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function showSeriesCoverPicker(ch, seriesLabel, files, after) {
  document.querySelector('.info-frame.cover-pick')?.remove();
  const title = seriesDisplayName(ch, seriesLabel);
  const frame = el('div', 'info-frame cover-pick');
  const box = el('div', 'info-box cover-pick-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Portada de la serie'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', title));
  body.append(el('p', 'cover-pick-hint', 'Elige la portada de un número de la serie o una imagen del dispositivo.'));

  const pickFile = el('button', 'btn cover-pick-device', '📁  Desde fotos o archivos');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  pickFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await setSeriesCoverBlob(ch, seriesLabel, file);
      frame.remove();
      after?.();
    } catch (e) {
      appAlert('No se pudo usar la imagen: ' + (e?.message || e));
    }
  };
  body.append(pickFile, fileInput);

  const grid = el('div', 'cover-pick-grid');
  body.append(el('div', 'info-sec', 'Números de la serie'));
  body.append(grid);

  const useCover = async (f) => {
    try {
      const b = await getCover(ch, f);
      if (!b) {
        appAlert('Este cómic aún no tiene portada en caché. Ábrelo una vez e inténtalo de nuevo.');
        return;
      }
      await setSeriesCoverBlob(ch, seriesLabel, b);
      frame.remove();
      after?.();
    } catch (e) {
      appAlert('No se pudo asignar la portada: ' + (e?.message || e));
    }
  };

  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    grid.append(el('div', 'info-loading', 'No hay cómics en esta serie.'));
  } else {
    for (const f of list) {
      const cell = el('button', 'cover-pick-cell');
      cell.type = 'button';
      const thumb = el('div', 'cover-pick-thumb');
      const lab = el('span', 'cover-pick-lab', issueLabel(seriesLabel, f, ch.name) || comicDisplay(comicSourceName(f), ch.name));
      cell.append(thumb, lab);
      cell.onclick = () => useCover(f);
      grid.append(cell);
      (async () => {
        const b = await getCover(ch, f);
        if (!b || !thumb.isConnected) return;
        const img = new Image();
        img.onload = () => { thumb.replaceChildren(img); };
        setBlobImg(img, b, thumb);
      })();
    }
  }

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
}

async function getChannelCoverBlob(ch, files) {
  try {
    const b = await kv.get(channelCoverKey(ch));
    if (b instanceof Blob && b.size) return b;
  } catch (_) {}
  // Generar desde el primer cómic y GUARDAR (evita re-descargas de varios segundos)
  const generated = await firstAvailableCover(ch, files);
  if (generated instanceof Blob && generated.size) {
    try { await setChannelCoverBlob(ch, generated); } catch (_) {}
    try {
      const cached = await kv.get(channelCoverKey(ch));
      if (cached instanceof Blob && cached.size) return cached;
    } catch (_) {}
    return generated;
  }
  return null;
}
async function setChannelCoverBlob(ch, blob) {
  if (!blob) return;
  try {
    const opt = await optimizeImageBlob(blob, 384, 0.75, { keepAlpha: true });
    await kv.set(channelCoverKey(ch), opt || blob);
  } catch (e) {
    console.warn('channel cover', e);
    try { await kv.set(channelCoverKey(ch), blob); } catch (_) {}
  }
}
function channelReadProgress(ch, files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  let done = 0;
  for (const f of list) {
    if (isComicRead(ch.id, f.id)) done++;
  }
  if (done === 0) return null;
  return { done, tot: list.length, pct: Math.round((done / list.length) * 100) };
}

function applyCoverProgress(node, prog) {
  if (!node || !prog) return;
  node.querySelector?.('.prog')?.remove();
  node.querySelector?.('.prog-badge')?.remove();
  const bar = el('div', 'prog');
  const fill = el('div', 'prog-fill');
  fill.style.width = prog.pct + '%';
  bar.append(fill);
  node.append(bar);
  node.append(el('span', 'prog-badge', prog.pct >= 95 ? '✓' : prog.pct + '%'));
}

function channelCoverNode(ch, files) {
  const host = el('div', 'cover cover-channel');
  const letter = el('span', '', (channelDisplayName(ch) || '?').slice(0, 1).toUpperCase());
  host.append(letter);
  const prog = channelReadProgress(ch, files);
  if (prog) applyCoverProgress(host, prog);

  const showOnHost = (blob) => {
    if (!blob || !host.isConnected) return;
    const img = new Image();
    img.onload = () => {
      if (!host.isConnected) return;
      try {
        if (img.naturalWidth > img.naturalHeight) host.classList.add('landscape');
        else host.classList.remove('landscape');
      } catch (_) {}
      host.replaceChildren(img);
      if (prog) applyCoverProgress(host, prog);
    };
    setBlobImg(img, blob, host);
  };

  host._load = async () => {
    // 1) Portada manual del canal
    try {
      const custom = await kv.get(channelCoverKey(ch));
      if (custom instanceof Blob && custom.size) {
        showOnHost(custom);
        return;
      }
    } catch (_) {}

    // 2) Arte GitHub / public/channels
    try {
      const gh = await getGithubChannelArtBlob(ch);
      if (gh instanceof Blob && gh.size) {
        showOnHost(gh);
        return;
      }
    } catch (_) {}

    // 3) Primer cómic del canal con portada → cachear en cc: para la próxima vez
    try {
      const comic = await firstAvailableCover(ch, files);
      if (comic) {
        showOnHost(comic);
        try { await setChannelCoverBlob(ch, comic); } catch (_) {}
        return;
      }
    } catch (_) {}
  };
  io.observe(host);
  return host;
}
async function clearChannelCover(ch) {
  try { await kv.del(channelCoverKey(ch)); } catch (_) {}
}
async function getGithubChannelArtBlob(ch, preferredUrl) {
  const nfc = (ch?.name || '').normalize('NFC').trim();
  const key = `art:channels:${artNorm(nfc)}`;
  const blobIsDecodable = (blob) => new Promise((resolve) => {
    if (!(blob instanceof Blob) || blob.size < 50) return resolve(false);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const ok = img.naturalWidth > 2 && img.naturalHeight > 2;
      try { URL.revokeObjectURL(url); } catch (_) {}
      resolve(ok);
    };
    img.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} resolve(false); };
    img.src = url;
  });
  try {
    if (!preferredUrl) {
      const cached = await kv.get(key);
      if (cached?.blob instanceof Blob && cached.blob.size >= 200 && !cached.fromComic) {
        if (await blobIsDecodable(cached.blob)) return cached.blob;
        try { await kv.del(key); } catch (_) {}
      }
    }
    const variants = listGithubArtVariants('channels', nfc);
    const urls = [];
    const seen = new Set();
    const add = (u) => { if (u && !seen.has(u)) { seen.add(u); urls.push(u); } };
    if (preferredUrl) add(preferredUrl);
    for (const v of variants) add(v.url);
    add(ART.channels[artNorm(nfc)]);
    add(ART.channels[artLoose(nfc)]);
    const nfd = (ch?.name || '').normalize('NFD').trim();
    const exts = ['webp', 'png', 'jpg', 'jpeg', 'avif', 'gif', 'WEBP', 'PNG', 'JPG', 'JPEG'];
    const altTags = ['', 'alt', 'alt1', 'alt2', 'alt3'];
    for (const n of [nfc, nfd, ch?.name]) {
      if (!n) continue;
      for (const e of exts) {
        for (const alt of altTags) {
          const stem = alt ? `${n}.${alt}` : n;
          add(`/channels/${encodeURIComponent(stem)}.${e}`);
          add(`/channels/${stem}.${e}`);
        }
      }
    }
    for (const url of urls) {
      try {
        const blob = await fetchOptimizeArtBlob(url, true);
        if (!blob || !blob.size) continue;
        const meta = { blob, url, optimized: true };
        // Solo guardar como predeterminada si no es una alternativa forzada distinta
        if (!preferredUrl || preferredUrl === url) {
          try { await kv.set(key, meta); } catch (_) {}
        }
        return blob;
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[art] channel github', e);
  }
  return null;
}

async function clearGroupCover(name) {
  try { await kv.del(groupCoverKey(name)); } catch (_) {}
}
async function setGroupCoverBlob(name, blob) {
  if (!blob) return;
  try {
    const opt = await optimizeImageBlob(blob, 384, 0.75, { keepAlpha: true });
    await kv.set(groupCoverKey(name), opt || blob);
  } catch (e) {
    try { await kv.set(groupCoverKey(name), blob); } catch (_) {}
  }
}
async function getGithubGroupArtBlob(name, preferredUrl) {
  const nfc = String(name || '').normalize('NFC').trim();
  const key = `art:groups:${artNorm(nfc)}`;
  try {
    if (!preferredUrl) {
      const cached = await kv.get(key);
      if (cached?.blob instanceof Blob && cached.blob.size >= 200) return cached.blob;
    }
    const variants = listGithubArtVariants('groups', nfc);
    const urls = [];
    const seen = new Set();
    const add = (u) => { if (u && !seen.has(u)) { seen.add(u); urls.push(u); } };
    if (preferredUrl) add(preferredUrl);
    for (const v of variants) add(v.url);
    add(ART.groups[artNorm(nfc)]);
    add(ART.groups[artLoose(nfc)]);
    const nfd = String(name || '').normalize('NFD').trim();
    const exts = ['webp', 'png', 'jpg', 'jpeg', 'avif', 'gif', 'WEBP', 'PNG', 'JPG', 'JPEG'];
    const altTags = ['', 'alt', 'alt1', 'alt2', 'alt3'];
    for (const n of [nfc, nfd, name]) {
      if (!n) continue;
      for (const e of exts) {
        for (const alt of altTags) {
          const stem = alt ? `${n}.${alt}` : n;
          add(`/groups/${encodeURIComponent(stem)}.${e}`);
          add(`/groups/${stem}.${e}`);
        }
      }
    }
    for (const url of urls) {
      try {
        const blob = await fetchOptimizeArtBlob(url, true);
        if (!blob || !blob.size) continue;
        if (!preferredUrl || preferredUrl === url) {
          try { await kv.set(key, { blob, url, optimized: true }); } catch (_) {}
        }
        return blob;
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[art] group github', e);
  }
  return null;
}
function groupCoverNode(originalName) {
  const host = el('div', 'cover square');
  const letter = el('span', '', (groupDisplayName(originalName) || '?').slice(0, 1).toUpperCase());
  host.append(letter);
  host._load = async () => {
    try {
      const custom = await kv.get(groupCoverKey(originalName));
      if (custom instanceof Blob) {
        const img = new Image();
        img.onload = () => {
          try {
            if (img.naturalWidth > img.naturalHeight) host.classList.add('landscape');
            else host.classList.remove('landscape');
          } catch (_) {}
          host.replaceChildren(img);
        };
        setBlobImg(img, custom, host);
        return;
      }
    } catch (_) {}
    const artNode = art('groups', originalName);
    if (host.parentNode) {
      host.replaceWith(artNode);
      artNode._load?.();
    } else {
      host.replaceChildren();
      host.append(artNode);
      artNode._load?.();
    }
  };
  io.observe(host);
  return host;
}
async function showGroupInfo(originalName) {
  try {
    document.querySelector('.info-frame.group-info')?.remove();
    const display = groupDisplayName(originalName);
    const chs = getLIB().filter((c) => c.group === originalName);
    let comics = 0, bytes = 0;
    for (const ch of chs) {
      const files = (await kv.get('f:' + ch.id)) || [];
      comics += files.length;
      for (const f of files) bytes += Number(f.size) || 0;
    }
    const frame = el('div', 'info-frame group-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Información'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Editorial'));
    body.append(row('Nombre', display));
    if (display !== originalName) body.append(row('Nombre original', originalName));
    body.append(row('Canales', String(chs.length)));
    body.append(row('Cómics (listados)', String(comics)));
    body.append(row('Tamaño total', formatBytes(bytes)));
    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error(err);
    appAlert('No se pudo mostrar la información de la editorial');
  }
}
function showEditGroup(originalName, after) {
  sheet(groupDisplayName(originalName), [
    ['Editar nombre de la editorial', () => showEditGroupName(originalName, after)],
    ['Seleccionar portada de la editorial', () => showGroupCoverPicker(originalName, after)],
  ]);
}
function showEditGroupName(originalName, after) {
  document.querySelector('.info-frame.edit-group')?.remove();
  const current = groupDisplayName(originalName);
  const frame = el('div', 'info-frame edit-group');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar nombre'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', 'Nombre de la editorial'));
  const input = el('input', 'edit-input');
  input.type = 'text';
  input.value = current;
  input.autocomplete = 'off';
  body.append(input);
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = () => {
    setGroupDisplayName(originalName, input.value, () => {
      frame.remove();
      after?.();
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
  setTimeout(() => { input.focus(); input.select(); }, 50);
}
async function showGroupCoverPicker(originalName, after) {
  document.querySelector('.info-frame.cover-pick')?.remove();
  const title = groupDisplayName(originalName);
  const frame = el('div', 'info-frame cover-pick');
  const box = el('div', 'info-box cover-pick-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Portada de la editorial'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', title));
  body.append(el('p', 'cover-pick-hint', 'GitHub, un canal, un cómic o una imagen del dispositivo.'));

  const pickFile = el('button', 'btn cover-pick-device', '📁  Desde fotos o archivos');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  pickFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await setGroupCoverBlob(originalName, file);
      frame.remove();
      after?.();
    } catch (e) {
      appAlert('No se pudo usar la imagen: ' + (e?.message || e));
    }
  };
  body.append(pickFile, fileInput);

  const addCell = (parent, label, loadThumb, onPick) => {
    const cell = el('button', 'cover-pick-cell');
    cell.type = 'button';
    const thumb = el('div', 'cover-pick-thumb');
    const lab = el('span', 'cover-pick-lab', label);
    cell.append(thumb, lab);
    cell.onclick = onPick;
    parent.append(cell);
    Promise.resolve().then(loadThumb).then((b) => {
      if (!b || !thumb.isConnected) return;
      const img = new Image();
      img.onload = () => { thumb.replaceChildren(img); };
      setBlobImg(img, b, thumb);
    }).catch(() => {});
  };

  const grid0 = el('div', 'cover-pick-grid');
  body.append(el('div', 'info-sec', 'Opciones'));
  body.append(grid0);
  const ghGroupVars = listGithubArtVariants('groups', originalName);
  if (!ghGroupVars.length) {
    addCell(grid0, 'GitHub / predeterminada', () => getGithubGroupArtBlob(originalName), async () => {
      await clearGroupCover(originalName);
      try {
        const b = await getGithubGroupArtBlob(originalName);
        if (b) await setGroupCoverBlob(originalName, b);
      } catch (_) {}
      frame.remove();
      after?.();
    });
  } else {
    for (const v of ghGroupVars) {
      const lab = v.primary
        ? (`Predeterminada: ${v.file}`)
        : (v.altTag ? (`${v.label}: ${v.file}`) : (`Alternativa (${v.ext}): ${v.file}`));
      addCell(grid0, lab, () => getGithubGroupArtBlob(originalName, v.url), async () => {
        await clearGroupCover(originalName);
        try {
          const b = await getGithubGroupArtBlob(originalName, v.url);
          if (b) await setGroupCoverBlob(originalName, b);
        } catch (_) {}
        frame.remove();
        after?.();
      });
    }
  }

  const chs = getLIB().filter((c) => c.group === originalName);
  if (chs.length) {
    body.append(el('div', 'info-sec', 'Canales'));
    const gridCh = el('div', 'cover-pick-grid');
    body.append(gridCh);
    for (const ch of chs) {
      addCell(gridCh, channelDisplayName(ch), async () => {
        try {
          const custom = await kv.get(channelCoverKey(ch));
          if (custom instanceof Blob) return custom;
        } catch (_) {}
        return getGithubChannelArtBlob(ch);
      }, async () => {
        let b = null;
        try {
          const custom = await kv.get(channelCoverKey(ch));
          if (custom instanceof Blob) b = custom;
        } catch (_) {}
        if (!b) b = await getGithubChannelArtBlob(ch);
        if (!b) {
          const files = (await kv.get('f:' + ch.id)) || [];
          if (files[0]) b = await getCover(ch, files[0]);
        }
        if (!b) {
          appAlert('Este canal aún no tiene portada en caché.');
          return;
        }
        await setGroupCoverBlob(originalName, b);
        frame.remove();
        after?.();
      });
    }

    body.append(el('div', 'info-sec', 'Cómics'));
    const gridComics = el('div', 'cover-pick-grid');
    body.append(gridComics);
    let any = false;
    for (const ch of chs) {
      const files = (await kv.get('f:' + ch.id)) || [];
      for (const f of files) {
        any = true;
        addCell(gridComics, comicDisplay(comicSourceName(f), ch.name), () => getCover(ch, f), async () => {
          const b = await getCover(ch, f);
          if (!b) {
            appAlert('Este cómic aún no tiene portada en caché. Ábrelo una vez e inténtalo de nuevo.');
            return;
          }
          await setGroupCoverBlob(originalName, b);
          frame.remove();
          after?.();
        });
      }
    }
    if (!any) gridComics.append(el('div', 'info-loading', 'No hay cómics listados.'));
  }

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
}

async function showChannelInfo(ch) {
  try {
    document.querySelector('.info-frame.channel-info')?.remove();
    const display = channelDisplayName(ch);
    let files = (await kv.get('f:' + ch.id)) || [];
    const n = files.length;
    let bytes = 0;
    for (const f of files) bytes += Number(f.size) || 0;
    let seriesCount = 0;
    try {
      const groups = groupSeries(files, ch.name, seriesOverrideFor(ch));
      seriesCount = groups.filter((g) => g.files.length > 1).length;
    } catch (_) {}
    const frame = el('div', 'info-frame channel-info');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Información'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    const row = (label, value) => {
      const r = el('div', 'info-row');
      r.append(el('span', 'info-label', label), el('span', 'info-value', String(value ?? '—')));
      return r;
    };
    body.append(el('div', 'info-sec', 'Canal'));
    body.append(row('Nombre', display));
    if (display !== ch.name) body.append(row('Nombre original', ch.name));
    body.append(row('Editorial', ch.group || '—'));
    body.append(row('Cómics', String(n)));
    body.append(row('Series (agrupadas)', String(seriesCount)));
    body.append(row('Tamaño total', formatBytes(bytes)));
    box.append(head, body);
    frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
    document.body.append(frame);
  } catch (err) {
    console.error(err);
    appAlert('No se pudo mostrar la información del canal');
  }
}
function showEditChannel(ch, files, after) {
  sheet(channelDisplayName(ch), [
    ['Editar nombre del canal', () => showEditChannelName(ch, after)],
    ['Seleccionar portada del canal', () => showChannelCoverPicker(ch, files || [], after)],
  ]);
}
function showEditChannelName(ch, after) {
  document.querySelector('.info-frame.edit-channel')?.remove();
  const current = channelDisplayName(ch);
  const frame = el('div', 'info-frame edit-channel');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Editar nombre'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', 'Nombre del canal'));
  const input = el('input', 'edit-input');
  input.type = 'text';
  input.value = current;
  input.autocomplete = 'off';
  body.append(input);
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => frame.remove();
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = () => {
    setChannelDisplayName(ch, input.value, () => {
      frame.remove();
      after?.();
    });
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
  setTimeout(() => { input.focus(); input.select(); }, 50);
}
function showChannelCoverPicker(ch, files, after) {
  document.querySelector('.info-frame.cover-pick')?.remove();
  const title = channelDisplayName(ch);
  const frame = el('div', 'info-frame cover-pick');
  const box = el('div', 'info-box cover-pick-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Portada del canal'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('div', 'info-sec', title));
  body.append(el('p', 'cover-pick-hint', 'Elige GitHub, un cómic del canal o una imagen del dispositivo.'));

  const pickFile = el('button', 'btn cover-pick-device', '📁  Desde fotos o archivos');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  pickFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await setChannelCoverBlob(ch, file);
      frame.remove();
      after?.();
    } catch (e) {
      appAlert('No se pudo usar la imagen: ' + (e?.message || e));
    }
  };
  body.append(pickFile, fileInput);

  const grid = el('div', 'cover-pick-grid');
  body.append(el('div', 'info-sec', 'Opciones'));
  body.append(grid);

  const addCell = (label, loadThumb, onPick) => {
    const cell = el('button', 'cover-pick-cell');
    cell.type = 'button';
    const thumb = el('div', 'cover-pick-thumb');
    const lab = el('span', 'cover-pick-lab', label);
    cell.append(thumb, lab);
    cell.onclick = onPick;
    grid.append(cell);
    Promise.resolve().then(loadThumb).then((b) => {
      if (!b || !thumb.isConnected) return;
      const img = new Image();
      img.onload = () => { thumb.replaceChildren(img); };
      setBlobImg(img, b, thumb);
    }).catch(() => {});
    return cell;
  };

  // 1) Portadas GitHub (predeterminada + alternativas .alt / otras extensiones)
  body.append(el('div', 'info-sec', 'GitHub'));
  const ghSecHint = el('p', 'cover-pick-hint', 'Buscando en GitHub…');
  body.append(ghSecHint);

  const addGhVariant = (v) => {
    const lab = v.primary
      ? (`Predeterminada: ${v.file}`)
      : (v.altTag ? (`${v.label}: ${v.file}`) : (`${v.label || 'Alternativa'}: ${v.file}`));
    addCell(lab, async () => {
      if (v.blob) return v.blob;
      return getGithubChannelArtBlob(ch, v.url);
    }, async () => {
      await clearChannelCover(ch);
      try {
        let b = v.blob || null;
        if (!b) b = await getGithubChannelArtBlob(ch, v.url);
        if (b) await setChannelCoverBlob(ch, b);
        try {
          const key = `art:channels:${artNorm((ch.name || '').normalize('NFC').trim())}`;
          if (b) await kv.set(key, { blob: b, url: v.url, optimized: true });
        } catch (_) {}
      } catch (_) {}
      frame.remove();
      after?.();
    });
  };

  (async () => {
    let ghVariants = [];
    try {
      ghVariants = listGithubArtVariants('channels', ch.name) || [];
    } catch (_) {}
    if (!ghVariants.length && typeof probeGithubArtVariants === 'function') {
      try { ghVariants = await probeGithubArtVariants('channels', ch.name); } catch (_) {}
    }
    try { ghSecHint.remove(); } catch (_) {}
    if (!ghVariants.length) {
      addCell('GitHub / predeterminada', () => getGithubChannelArtBlob(ch), async () => {
        await clearChannelCover(ch);
        try {
          const b = await getGithubChannelArtBlob(ch);
          if (b) await setChannelCoverBlob(ch, b);
        } catch (_) {}
        frame.remove();
        after?.();
      });
    } else {
      for (const v of ghVariants) addGhVariant(v);
    }
  })();

  // 2) Todos los cómics del canal (también los de series desagrupadas)
  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    grid.append(el('div', 'info-loading', 'No hay cómics en este canal.'));
  } else {
    body.append(el('div', 'info-sec', 'Cómics del canal'));
    const gridComics = el('div', 'cover-pick-grid');
    body.append(gridComics);
    for (const f of list) {
      const cell = el('button', 'cover-pick-cell');
      cell.type = 'button';
      const thumb = el('div', 'cover-pick-thumb');
      const lab = el('span', 'cover-pick-lab', comicDisplay(comicSourceName(f), ch.name));
      cell.append(thumb, lab);
      cell.onclick = async () => {
        const b = await getCover(ch, f);
        if (!b) {
          appAlert('Este cómic aún no tiene portada en caché. Ábrelo una vez e inténtalo de nuevo.');
          return;
        }
        await setChannelCoverBlob(ch, b);
        frame.remove();
        after?.();
      };
      gridComics.append(cell);
      (async () => {
        const b = await getCover(ch, f);
        if (!b || !thumb.isConnected) return;
        const img = new Image();
        img.onload = () => { thumb.replaceChildren(img); };
        setBlobImg(img, b, thumb);
      })();
    }
  }

  box.append(head, body);
  frame.append(box);
  // No cerrar al pulsar fuera: solo × / Cancelar
  document.body.append(frame);
}



/** Carga la 1ª página del cómic a calidad completa (no la miniatura de caché). */
async function loadFirstPageBlob(ch, f, statusFn) { return loadPageBlob(ch, f, 0, statusFn); }

/** Carga la página idx (0 = primera) del cómic a calidad completa. Si no existe, usa la última. */
async function loadPageBlob(ch, f, idx, statusFn) {
  if (typeof openPages !== 'function' || typeof getMsg !== 'function') {
    throw new Error('No se puede abrir el archivo');
  }
  const msg = await getMsg(ch, f, { force: true });
  let size = Number(f?.size) || 0;
  try {
    if (msg?.document?.size != null) size = Number(msg.document.size.toString()) || size;
  } catch (_) {}
  const ac = { cancelled: false };
  const st = statusFn || (() => {});
  const pagesApi = await openPages(msg, size, st, ac);
  try {
    const pages = pagesApi?.pages || [];
    if (!pages.length) throw new Error('Sin páginas');
    const first = pages[Math.max(0, Math.min(pages.length - 1, Number(idx) || 0))];
    let blob = null;
    if (typeof pageBlob === 'function') blob = await pageBlob(first);
    else if (first?.blob) blob = first.blob;
    if (!blob) throw new Error('No se pudo leer la página del cómic');
    return blob;
  } finally {
    try { pagesApi?.close?.(); } catch (_) {}
  }
}

/**
 * Recorta portada apaisada a ratio 2:3 según modo y comprime como el resto de portadas.
 * left | center | right → crop; full → imagen completa sin crop lateral.
 */
/**
 * Recorta portada apaisada y comprime como el resto de portadas.
 * mode: left | center | right | full
 * exactHalf: solo left/right — corta el ancho exactamente a la mitad (izq. o der.), alto completo.
 */
function coverCropRect(sw, sh, mode, exactHalf = false) {
  const isLandscape = sw > sh;
  const m = String(mode || 'full');
  let sx = 0, sy = 0, cw = sw, ch = sh;
  if (isLandscape && (m === 'left' || m === 'center' || m === 'right')) {
    if (exactHalf && (m === 'left' || m === 'right')) {
      // Mitad EXACTA del ancho (p.ej. 2560 → 1280), alto completo. Sin más recorte.
      cw = Math.max(1, Math.floor(sw / 2));
      ch = sh;
      sx = m === 'right' ? (sw - cw) : 0;
      sy = 0;
    } else {
      // Comportamiento habitual: ventana 2:3 anclada a izq/centro/der
      const targetRatio = 2 / 3;
      ch = sh;
      cw = Math.round(ch * targetRatio);
      if (cw > sw) {
        cw = sw;
        ch = Math.round(cw / targetRatio);
        sy = Math.round((sh - ch) / 2);
      }
      if (m === 'center') sx = Math.round((sw - cw) / 2);
      else if (m === 'right') sx = Math.max(0, sw - cw);
      else sx = 0;
    }
  }
  return { sx, sy, cw, ch };
}

/**
 * Portada personalizada recordada por cómic: SOLO datos pequeños (nº de página elegida,
 * modo y recorte a la mitad). La imagen se vuelve a leer del cómic cada vez; no se guarda ninguna.
 */
const coverAdaptKey = (ch, f) => `coverAdapt:${ch.id}:${f.id}`;
function getCoverAdapt(ch, f) {
  try {
    const v = JSON.parse(localStorage.getItem(coverAdaptKey(ch, f)) || 'null');
    if (v && typeof v === 'object') {
      return {
        page: Math.max(0, Math.floor(Number(v.page) || 0)),
        mode: ['left', 'center', 'right', 'full'].includes(v.mode) ? v.mode : 'full',
        half: v.half !== false,
      };
    }
  } catch (_) {}
  return null;
}
function setCoverAdapt(ch, f, v) {
  try {
    if (v) localStorage.setItem(coverAdaptKey(ch, f), JSON.stringify({
      page: Math.max(0, Math.floor(Number(v.page) || 0)),
      mode: v.mode || 'full',
      half: v.half !== false,
    }));
    // Borrar = marca '0' (no quitar la clave): si no, la sincronización recuperaría el valor remoto
    else if (localStorage.getItem(coverAdaptKey(ch, f)) != null) localStorage.setItem(coverAdaptKey(ch, f), '0');
  } catch (_) {}
  try { sync.schedulePush(); } catch (_) {}
}

async function cropAndCompressCover(blob, mode, exactHalf = false) {
  if (!blob) return null;
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
  const sw = bmp.width || bmp.naturalWidth || 0;
  const sh = bmp.height || bmp.naturalHeight || 0;
  if (!sw || !sh) {
    try { bmp.close?.(); } catch (_) {}
    return null;
  }
  const { sx, sy, cw, ch } = coverCropRect(sw, sh, mode, exactHalf);
  const maxEdge = 560;
  const scale = Math.min(1, maxEdge / Math.max(cw, ch));
  const dw = Math.max(1, Math.round(cw * scale));
  const dh = Math.max(1, Math.round(ch * scale));
  const cv = el('canvas');
  cv.width = dw;
  cv.height = dh;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, sx, sy, cw, ch, 0, 0, dw, dh);
  try { bmp.close?.(); } catch (_) {}
  const canvasToBlob = (type, q) => new Promise((res) => {
    try { cv.toBlob((b) => res(b || null), type, q); } catch { res(null); }
  });
  let out = null;
  try {
    out = await canvasToBlob('image/webp', 0.78);
    if (!(out && out.size && (out.type || '').includes('webp'))) out = null;
  } catch (_) {}
  if (!out) out = await canvasToBlob('image/jpeg', 0.72);
  if (!out) out = await canvasToBlob('image/jpeg', 0.55);
  cv.width = 0;
  cv.height = 0;
  if (!(out && out.size) && typeof optimizeImageBlob === 'function') {
    try { out = await optimizeImageBlob(blob, 280, 0.72); } catch (_) {}
  }
  return out && out.size ? out : blob;
}

/** Adaptar portada: usa página real del cómic, recorta y guarda comprimida */
function showCoverFitEditor(ch, f, after) {
  document.querySelector('.info-frame.cover-fit')?.remove();
  const frame = el('div', 'info-frame cover-fit');
  const box = el('div', 'info-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Adaptar portada'));
  const close = el('button', 'btn info-close', '×');
  close.onclick = () => frame.remove();
  head.append(close);
  const body = el('div', 'info-body');
  const hintEl = el('p', 'cover-pick-hint', 'Se usa la primera página del cómic (calidad completa). Izquierda / Centro / Derecha recortan al marco 2:3 y guardan la portada comprimida.');
  body.append(hintEl);

  const preview = el('div', 'cover-fit-preview');
  body.append(preview);
  // Selección recordada de la vez anterior (modo + recorte exacto a la mitad)
  const mem = getCoverAdapt(ch, f);
  let current = mem?.mode || 'full';
  let sourceBlob = null;
  const srcPage = mem?.page || 0; // página del cómic elegida como portada (0 = primera)
  let srcBmp = null;
  let previewCv = null;
  // Preview real: dibuja exactamente el recorte que se guardará
  const updatePreview = () => {
    if (!srcBmp || !preview.isConnected) return;
    const sw = srcBmp.width || srcBmp.naturalWidth, sh = srcBmp.height || srcBmp.naturalHeight;
    const exact = !!(halfChkRef && halfChkRef.checked && (current === 'left' || current === 'right'));
    const { sx, sy, cw, ch: chh } = coverCropRect(sw, sh, current, exact);
    const scale = Math.min(1, 480 / Math.max(cw, chh));
    if (!previewCv) {
      previewCv = el('canvas', 'cover-fit-canvas');
      preview.replaceChildren(previewCv);
    }
    previewCv.width = Math.max(1, Math.round(cw * scale));
    previewCv.height = Math.max(1, Math.round(chh * scale));
    previewCv.getContext('2d').drawImage(srcBmp, sx, sy, cw, chh, 0, 0, previewCv.width, previewCv.height);
    // Igual que en la rejilla: apaisada → completa (contain); vertical → rellena el marco (cover)
    preview.classList.toggle('cropped', cw <= chh);
  };

  const optsWrap = el('div', 'cover-fit-opts');
  const modes = [
    ['left', 'Izquierda', 'Recorte al alto desde la izquierda'],
    ['center', 'Centro', 'Recorte al alto desde el centro'],
    ['right', 'Derecha', 'Recorte al alto desde la derecha'],
    ['full', 'Completa', 'Imagen completa sin recorte lateral'],
  ];
  const buttons = [];
  let halfChkRef = null;
  const select = (mode) => {
    current = mode;
    for (const [b, m] of buttons) b.classList.toggle('on', m === mode);
    if (halfChkRef) {
      const lr = mode === 'left' || mode === 'right';
      halfChkRef.disabled = !lr;
      halfChkRef.parentElement?.classList.toggle('dim', !lr);
    }
    updatePreview();
  };
  for (const [mode, lab, hint] of modes) {
    const b = el('button', 'cover-fit-opt' + (mode === current ? ' on' : ''));
    b.type = 'button';
    const dot = el('span', 'dot');
    const txt = el('span', '');
    txt.append(el('b', '', lab));
    txt.append(document.createTextNode(' — ' + hint));
    b.append(dot, txt);
    b.onclick = () => select(mode);
    buttons.push([b, mode]);
    optsWrap.append(b);
  }
  // Check encima de Izquierda; solo afecta Izquierda / Derecha
  const halfRow = el('label', 'cover-fit-half');
  const halfChk = el('input');
  halfChk.type = 'checkbox';
  halfChk.checked = mem ? mem.half : true;
  halfChk.onchange = () => updatePreview();
  halfRow.append(halfChk, document.createTextNode(' Recorte EXACTO a la mitad'));
  body.append(halfRow);
  halfChkRef = halfChk;
  {
    const lr = current === 'left' || current === 'right';
    halfChk.disabled = !lr;
    halfRow.classList.toggle('dim', !lr);
  }

  body.append(optsWrap);

  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  const closeFit = () => { try { srcBmp?.close?.(); } catch (_) {} srcBmp = null; frame.remove(); };
  close.onclick = closeFit;
  cancel.onclick = closeFit;
  const save = el('button', 'btn edit-save', 'Guardar');
  save.onclick = async () => {
    if (!sourceBlob) {
      appAlert('Aún no se ha cargado la página del cómic.');
      return;
    }
    try {
      save.disabled = true;
      save.textContent = 'Guardando…';
      const exactHalf = !!(halfChk.checked && (current === 'left' || current === 'right'));
      const out = await cropAndCompressCover(sourceBlob, current, exactHalf);
      if (!out) throw new Error('No se pudo procesar la imagen');
      // Primero la configuración (página/modo, se sincroniza) y luego la portada: así queda marcada como ya aplicada aquí
      setCoverAdapt(ch, f, { page: srcPage, mode: current, half: halfChk.checked });
      await saveCoverBlob(ch, f, out, { custom: true });
      // La portada ya está recortada: resetear fit visual a full
      try { if (typeof setCoverFit === 'function') setCoverFit(ch, f, 'full'); } catch (_) {}
      closeFit();
      try { after?.(); } catch (_) {}
    } catch (e) {
      appAlert('No se pudo guardar: ' + (e?.message || e));
    } finally {
      save.disabled = false;
      save.textContent = 'Guardar';
    }
  };
  actions.append(cancel, save);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);

  (async () => {
    try {
      const loading = el('div', 'info-loading', 'Cargando página del cómic…');
      preview.append(loading);
      // Siempre se lee del propio cómic la página recordada (no la miniatura de caché)
      if (srcPage > 0) {
        hintEl.textContent = 'Se usa la página ' + (srcPage + 1) + ' del cómic, la que elegiste para esta portada (calidad completa). Izquierda / Centro / Derecha recortan al marco 2:3 y guardan la portada comprimida.';
      }
      sourceBlob = await loadPageBlob(ch, f, srcPage, (t) => {
        try { loading.textContent = t || 'Cargando…'; } catch (_) {}
      });
      if (!preview.isConnected) return;
      try {
        srcBmp = await createImageBitmap(sourceBlob);
      } catch (_) {
        srcBmp = await new Promise((resolve, reject) => {
          const im = new Image();
          const u = URL.createObjectURL(sourceBlob);
          im.onload = () => { try { URL.revokeObjectURL(u); } catch (_) {} resolve(im); };
          im.onerror = reject;
          im.src = u;
        });
      }
      if (!preview.isConnected) return;
      const landscape = (srcBmp.width || srcBmp.naturalWidth) > (srcBmp.height || srcBmp.naturalHeight);
      if (landscape) preview.classList.add('landscape'); else preview.classList.remove('landscape');
      updatePreview();
      if (!landscape) {
        body.insertBefore(
          el('p', 'cover-pick-hint', 'La imagen no es apaisada; Completa guarda la imagen entera. Izquierda/Centro/Derecha solo recortan si es más ancha que alta.'),
          optsWrap
        );
      }
    } catch (e) {
      preview.replaceChildren();
      preview.append(el('div', 'info-loading', 'Error: ' + (e?.message || e)));
    }
  })();
}

/** Elegir una página del cómic como portada; al terminar vuelve al callback (submenú Editar). */
async function showPickCoverFromComic(ch, f, after) {
  document.querySelector('.info-frame.cover-pages')?.remove();
  const frame = el('div', 'info-frame cover-pages');
  const box = el('div', 'info-box cover-pick-box');
  const head = el('div', 'info-head');
  head.append(el('span', '', 'Elegir portada'));
  const close = el('button', 'btn info-close', '×');
  let pagesApi = null;
  const acRef = { cancelled: false };
  const doClose = (reopenEdit) => {
    acRef.cancelled = true;
    try { pagesApi?.close?.(); } catch (_) {}
    frame.remove();
    if (reopenEdit) {
      try { after?.(); } catch (_) {}
    }
  };
  close.onclick = () => doClose(true);
  head.append(close);
  const body = el('div', 'info-body');
  body.append(el('p', 'cover-pick-hint', 'Pulsa una página para usarla como portada del cómic.'));
  const status = el('div', 'info-loading', 'Abriendo cómic…');
  body.append(status);
  const gridEl = el('div', 'cover-pages-grid');
  gridEl.hidden = true;
  body.append(gridEl);
  const actions = el('div', 'edit-actions');
  const cancel = el('button', 'btn', 'Cancelar');
  cancel.onclick = () => doClose(true);
  actions.append(cancel);
  body.append(actions);
  box.append(head, body);
  frame.append(box);
  document.body.append(frame);

  try {
    if (typeof openPages !== 'function' || typeof getMsg !== 'function') {
      throw new Error('No se puede abrir el archivo en este contexto');
    }
    const msg = await getMsg(ch, f, { force: true });
    let size = Number(f?.size) || 0;
    try {
      if (msg?.document?.size != null) size = Number(msg.document.size.toString()) || size;
    } catch (_) {}
    const st = (t) => { try { status.textContent = t; } catch (_) {} };
    pagesApi = await openPages(msg, size, st, acRef);
    const pages = pagesApi?.pages || [];
    if (!pages.length) throw new Error('Sin páginas de imagen');
    status.textContent = pages.length + ' páginas — cargando miniaturas…';
    gridEl.hidden = false;

    const loadOne = async (entry, idx) => {
      const cell = el('button', 'cover-pages-cell');
      cell.type = 'button';
      cell.append(el('span', 'pg-n', String(idx + 1)));
      gridEl.append(cell);
      try {
        let blob = null;
        if (typeof pageBlob === 'function') blob = await pageBlob(entry);
        else if (entry?.blob) blob = entry.blob;
        if (!blob || !cell.isConnected) return;
        let thumb = blob;
        try {
          if (typeof optimizeImageBlob === 'function') {
            const t = await optimizeImageBlob(blob, 200, 0.7);
            if (t && t.size) thumb = t;
          }
        } catch (_) {}
        const img = new Image();
        img.onload = () => {
          if (!cell.isConnected) return;
          const n = cell.querySelector('.pg-n');
          cell.replaceChildren(img);
          if (n) cell.append(n);
        };
        setBlobImg(img, thumb, cell);
        cell.onclick = async () => {
          try {
            cell.disabled = true;
            status.textContent = 'Guardando portada…';
            // Guardar página completa (saveCoverBlob comprime como el resto)
            // Primero se recuerda solo el nº de página (se sincroniza; Adaptar la vuelve a leer del cómic), recorte reiniciado
            setCoverAdapt(ch, f, { page: idx, mode: 'full', half: true });
            await saveCoverBlob(ch, f, blob, { custom: true });
            doClose(true);
          } catch (e) {
            cell.disabled = false;
            appAlert('No se pudo guardar: ' + (e?.message || e));
          }
        };
      } catch (_) {}
    };

    const BATCH = 6;
    for (let i = 0; i < pages.length; i += BATCH) {
      if (!frame.isConnected || acRef.cancelled) break;
      await Promise.all(pages.slice(i, i + BATCH).map((p, j) => loadOne(p, i + j)));
      status.textContent = 'Miniaturas ' + Math.min(i + BATCH, pages.length) + ' / ' + pages.length;
    }
    if (frame.isConnected) status.textContent = 'Elige una página';
  } catch (e) {
    status.textContent = 'Error: ' + (e?.message || e);
  }
}


  return {
    showComicInfo,
    showCoverFitEditor,
    showPickCoverFromComic,
    showDescriptionPanel: typeof showDescriptionPanel === 'function' ? showDescriptionPanel : undefined,
    showCaptionEditor,
    showComicVinePicker,
    showEditComicTitle,
    showSeriesInfo,
    showEditSeries,
    showEditSeriesName,
    showSeriesCoverPicker,
    seriesCoverNode,
    channelCoverNode,
    groupCoverNode,
    showGroupInfo,
    showEditGroup,
    showEditGroupName,
    showGroupCoverPicker,
    showChannelInfo,
    showEditChannel,
    showEditChannelName,
    showChannelCoverPicker,
    getChannelCoverBlob,
    setChannelCoverBlob,
    clearChannelCover,
    getSeriesCoverBlob,
    setSeriesCoverBlob,
    firstAvailableCover,
    getGithubChannelArtBlob: typeof getGithubChannelArtBlob === 'function' ? getGithubChannelArtBlob : d.getGithubChannelArtBlob,
    getGithubGroupArtBlob: typeof getGithubGroupArtBlob === 'function' ? getGithubGroupArtBlob : d.getGithubGroupArtBlob,
  };
}
