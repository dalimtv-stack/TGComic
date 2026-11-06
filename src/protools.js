/**
 * Herramientas avanzadas (Configuración Avanzada).
 * - Recargar portadas con filtro Editorial / Canal / Serie
 * - Progreso de borrado y de regeneración
 */
import * as sync from './sync.js';

export function createProTools(d) {
  const {
    el,
    kv,
    getCover,
    generateCover,
    pump: coverPump,
    groupSeries,
    seriesOverrideFor,
    groupDisplayName,
    channelDisplayName,
    seriesDisplayName,
    comicSourceName,
    appConfirm,
    appAlert,
    closeAppMenu,
    onCoversChanged,
    copyInfoFrameText,
    clearAllReadingData,
    getPagesTotal,
    setPagesTotal,
    getMsg,
    openPages,
    reloadStructureCovers,
  } = d;
  const getLIB = () => {
    try {
      if (typeof d.LIB === 'function') return d.LIB() || [];
      return Array.isArray(d.LIB) ? d.LIB : [];
    } catch (_) { return []; }
  };
  const getClient = () => d.client;
  const getReady = () => d.ready;

  // Preferencias solo locales (mismo prefijo que main)
  const pref = (k, def = '') => {
    try {
      if (typeof d.pref === 'function') return d.pref(k, def);
      const v = localStorage.getItem('pref:' + k);
      return v == null ? def : v;
    } catch { return def; }
  };
  const setPref = (k, v) => {
    try {
      if (typeof d.setPref === 'function') return d.setPref(k, v);
      localStorage.setItem('pref:' + k, String(v));
    } catch (_) {}
  };

  // Tamaños de portadas/textos: SOLO este dispositivo ('device:'), nunca sincronizados
  const devPref = (k, def = '') => {
    try {
      if (typeof d.devPref === 'function') return d.devPref(k, def);
      const v = localStorage.getItem('device:' + k);
      return v == null || v === '' ? def : v;
    } catch { return def; }
  };
  const setDevPref = (k, v) => {
    try {
      if (typeof d.setDevPref === 'function') return d.setDevPref(k, v);
      localStorage.setItem('device:' + k, String(v));
    } catch (_) {}
  };


  function uniqueSorted(arr, cmp) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const k = String(x || '').toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out.sort(cmp || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })));
  }

  /** Título de la app (mismo patrón que «Actualizando…»). */
  function appTitleEl() {
    try { return document.querySelector('#title'); } catch { return null; }
  }

  /**
   * Pantalla de progreso con slots concurrentes, Cancelar y Segundo plano.
   * opts.slots = número de líneas de trabajo en paralelo (p. ej. 3 → 6 líneas: nombre + estado).
   */
  function showProgressFrame(title, opts = {}) {
    document.querySelector('.info-frame.protools-progress')?.remove();
    const frame = el('div', 'info-frame protools-progress');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    const titleSpan = el('span', '', title || 'Progreso');
    head.append(titleSpan);
    box.append(head);
    const body = el('div', 'info-body');

    // Estado global (1 línea) + slots concurrentes (2 líneas cada uno: título + detalle)
    const status = el('p', 'cover-pick-hint protools-status-main', 'Preparando…');
    body.append(status);

    const nSlots = Math.max(0, Math.min(8, Number(opts.slots) || 0));
    const slotEls = [];
    const slotsWrap = el('div', 'protools-slots');
    slotsWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:0.5rem 0 0.75rem;';
    if (nSlots > 0) {
      for (let i = 0; i < nSlots; i++) {
        const row = el('div', 'protools-slot');
        row.hidden = true;
        row.style.cssText = 'padding:8px 10px;border-radius:10px;background:#ffffff0c;border:1px solid #ffffff12;';
        const name = el('div', 'protools-slot-name', '');
        name.style.cssText = 'font-size:0.88rem;font-weight:600;word-break:break-word;line-height:1.3;';
        const detail = el('div', 'protools-slot-detail', '');
        detail.style.cssText = 'font-size:0.78rem;color:var(--mut,#8b8d94);margin-top:2px;line-height:1.3;';
        row.append(name, detail);
        slotsWrap.append(row);
        slotEls.push({ row, name, detail, busy: false });
      }
      body.append(slotsWrap);
    }

    const bar = el('div', 'repack-panel-bar');
    const fill = el('div', 'repack-panel-fill');
    fill.style.width = '0%';
    bar.append(fill);
    const count = el('p', 'cover-pick-hint', '');
    body.append(bar, count);

    const actions = el('div', 'edit-actions protools-progress-actions');
    const btnCancel = el('button', 'btn', 'Cancelar');
    const btnBg = el('button', 'btn edit-save', 'Segundo plano');
    actions.append(btnCancel, btnBg);
    body.append(actions);

    box.append(body);
    frame.append(box);
    document.body.append(frame);

    const state = {
      cancelled: false,
      background: false,
      done: 0,
      total: 0,
      title: title || 'Progreso',
      prevTitle: '',
    };
    try {
      const te = appTitleEl();
      if (te) state.prevTitle = te.textContent || 'TGComics';
    } catch (_) {}

    const paintTitleBg = () => {
      if (!state.background) return;
      try {
        const te = appTitleEl();
        if (!te) return;
        const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
        te.textContent = state.total
          ? `${state.title}… ${state.done}/${state.total} (${pct}%)`
          : `${state.title}…`;
      } catch (_) {}
    };

    const api = {
      frame,
      get cancelled() { return state.cancelled; },
      get background() { return state.background; },
      setTitle(t) {
        state.title = t || state.title;
        try { titleSpan.textContent = state.title; } catch (_) {}
        paintTitleBg();
      },
      setStatus(t) {
        try { status.textContent = t || ''; } catch (_) {}
      },
      /** Asigna un slot libre; devuelve id o -1 */
      acquireSlot() {
        for (let i = 0; i < slotEls.length; i++) {
          if (!slotEls[i].busy) {
            slotEls[i].busy = true;
            slotEls[i].row.hidden = false;
            return i;
          }
        }
        return -1;
      },
      releaseSlot(id) {
        const s = slotEls[id];
        if (!s) return;
        s.busy = false;
        s.row.hidden = true;
        s.name.textContent = '';
        s.detail.textContent = '';
      },
      /** Actualiza nombre (línea 1) y detalle (línea 2) de un slot */
      setSlot(id, nameText, detailText) {
        const s = slotEls[id];
        if (!s) return;
        s.busy = true;
        s.row.hidden = false;
        try {
          s.name.textContent = nameText || '';
          s.detail.textContent = detailText || '';
        } catch (_) {}
      },
      setProgress(done, total) {
        state.done = done;
        state.total = total;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        try {
          fill.style.width = pct + '%';
          count.textContent = total ? `${done} / ${total} (${pct}%)` : '';
        } catch (_) {}
        paintTitleBg();
      },
      close() {
        state.closed = true;
        try { topEl?.removeEventListener('click', onTopClick, true); } catch (_) {}
        try { frame.remove(); } catch (_) {}
        if (state.background) {
          try {
            const te = appTitleEl();
            if (te && state.prevTitle) te.textContent = state.prevTitle;
          } catch (_) {}
        }
      },
      /** Restaura el título al terminar en segundo plano */
      restoreTitle() {
        try {
          const te = appTitleEl();
          if (te && state.prevTitle) te.textContent = state.prevTitle;
        } catch (_) {}
        state.background = false;
      },
    };

    const topEl = document.querySelector('#top');
    /** Clic en la barra superior (no en botones) → volver a primer plano */
    const onTopClick = (ev) => {
      if (!state.background || state.cancelled || state.closed) return;
      if (ev.target.closest('button, a, input, select, textarea, .btn, .app-menu-item, .menu-btn, .search-filters-btn')) return;
      state.background = false;
      try {
        if (!frame.isConnected) document.body.append(frame);
        frame.style.display = '';
      } catch (_) {}
      // Título de la app otra vez normal; el detalle sigue en el frame
      try {
        const te = appTitleEl();
        if (te && state.prevTitle) te.textContent = state.prevTitle;
      } catch (_) {}
      try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
    };
    try { topEl?.addEventListener('click', onTopClick, true); } catch (_) {}

    btnCancel.onclick = () => {
      state.cancelled = true;
      try { status.textContent = 'Cancelando…'; } catch (_) {}
      try { btnCancel.disabled = true; btnBg.disabled = true; } catch (_) {}
      // Si estaba en segundo plano, mostrar de nuevo el frame un momento con "Cancelando…"
      if (state.background) {
        state.background = false;
        try {
          if (!frame.isConnected) document.body.append(frame);
        } catch (_) {}
      }
    };
    btnBg.onclick = () => {
      state.background = true;
      // Quitar del DOM: body:has(.info-frame) bloquea clics en #app
      try { frame.remove(); } catch (_) {}
      paintTitleBg();
    };

    return api;
  }

  /**
   * Lista de { ch, f, key } según filtros.
   * editorial/channel/series: '' = Todas
   */
  async function collectTargets({ editorial = '', channelId = '', seriesLabel = '' } = {}) {
    const lib = getLIB();
    let channels = lib.slice();
    if (editorial) {
      channels = channels.filter((c) => String(c.group || '') === editorial);
    }
    if (channelId) {
      channels = channels.filter((c) => String(c.id) === String(channelId));
    }
    const targets = [];
    for (const ch of channels) {
      let files = [];
      try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) { files = []; }
      if (!Array.isArray(files) || !files.length) continue;

      if (seriesLabel) {
        const groups = groupSeries(files, ch.name, seriesOverrideFor?.(ch));
        const g = groups.find((x) => String(x.label) === seriesLabel);
        const list = g ? g.files : [];
        for (const f of list) {
          if (!f?.id) continue;
          targets.push({ ch, f, key: `c:${ch.id}:${f.id}` });
        }
      } else {
        for (const f of files) {
          if (!f?.id) continue;
          targets.push({ ch, f, key: `c:${ch.id}:${f.id}` });
        }
      }
    }
    return targets;
  }

  /** 'adapt' = personalizada regenerable (página elegida) · 'fixed' = personalizada sin datos para regenerar · '' = por defecto */
  async function customKind(t) {
    try {
      const raw = localStorage.getItem(`coverAdapt:${t.ch.id}:${t.f.id}`);
      if (raw && raw !== '0') {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object') return 'adapt';
      }
    } catch (_) {}
    try { if (await kv.get(`ccustom:${t.ch.id}:${t.f.id}`)) return 'fixed'; } catch (_) {}
    return '';
  }

  /** Borra portadas conservando la personalización: las adaptadas se regeneran con la misma página; las fijas se mantienen. */
  async function deleteCoverKeys(targets, onProgress) {
    let done = 0;
    const total = targets.length;
    const keep = [];
    for (const t of targets) {
      const kind = await customKind(t);
      if (kind === 'fixed') {
        keep.push(t);
      } else {
        try { await kv.del(t.key); } catch (_) {}
        // Personalizada por página: se borra solo la marca aplicada para que se regenere con la misma configuración
        if (kind === 'adapt') { try { await kv.del(`ccustom:${t.ch.id}:${t.f.id}`); } catch (_) {} }
      }
      done++;
      if (done % 5 === 0 || done === total) onProgress?.(done, total);
      if (done % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    targets.keep = keep;
    return done - keep.length;
  }

  async function regenerateCovers(targets, onProgress, prog) {
    let done = 0;
    let okN = 0;
    const total = targets.length;
    const skip = new Set(targets.keep || []);
    const CONC = 3;
    const queue = targets.filter((t) => !skip.has(t));
    // Los "keep" ya cuentan como hechos
    done = total - queue.length;
    onProgress?.(done, total);
    let next = 0;
    const worker = async () => {
      while (true) {
        if (prog?.cancelled) return;
        const i = next++;
        if (i >= queue.length) return;
        const t = queue[i];
        const label = String(t.f?.name || t.f?.id || '').slice(0, 60);
        const slot = prog?.acquireSlot?.() ?? -1;
        if (slot >= 0) prog.setSlot(slot, label, 'Generando…');
        try {
          if (typeof d.invalidateComicLocal === 'function') {
            try { await d.invalidateComicLocal(t.ch, t.f); } catch (_) {}
          }
          if (typeof generateCover === 'function') {
            const b = await generateCover(t.ch, t.f, {
              status: (tx) => { if (slot >= 0) prog.setSlot(slot, label, String(tx || '')); },
            });
            if (b) okN++;
          } else if (typeof getCover === 'function') {
            const b = await getCover(t.ch, t.f, { force: true });
            if (b) okN++;
          }
        } catch (_) {}
        if (slot >= 0) prog.releaseSlot(slot);
        done++;
        onProgress?.(done, total);
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, queue.length || 1) }, () => worker()));
    return okN;
  }

  function fillSelect(sel, items, placeholder) {
    sel.replaceChildren();
    const o0 = el('option');
    o0.value = '';
    o0.textContent = placeholder || 'Todas';
    sel.append(o0);
    for (const it of items) {
      const o = el('option');
      o.value = it.value;
      o.textContent = it.label;
      sel.append(o);
    }
  }

  /** Formulario: Editorial / Canal / Serie (por defecto Todas). */
  function showReloadCoversFrame() {
    document.querySelector('.info-frame.adv-config')?.remove();
    document.querySelector('.info-frame.protools-covers')?.remove();

    const frame = el('div', 'info-frame protools-covers');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Recargar portadas'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);

    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      'Elige el alcance. «Todas» afecta a toda la biblioteca visible. Se borran las portadas en caché y se regeneran automáticamente (puede tardar).'
    ));

    const lib = getLIB();
    const editorials = uniqueSorted(
      lib.map((c) => c.group).filter(Boolean)
    );

    body.append(el('label', 'sync-label', 'Editorial'));
    const editorialSel = el('select', 'edit-input upload-select');
    fillSelect(
      editorialSel,
      editorials.map((g) => ({
        value: g,
        label: (typeof groupDisplayName === 'function' ? groupDisplayName(g) : g) || g,
      })),
      'Todas'
    );
    body.append(editorialSel);

    body.append(el('label', 'sync-label', 'Canal'));
    const channelSel = el('select', 'edit-input upload-select');
    fillSelect(channelSel, [], 'Todas');
    body.append(channelSel);

    body.append(el('label', 'sync-label', 'Serie'));
    const seriesSel = el('select', 'edit-input upload-select');
    fillSelect(seriesSel, [], 'Todas');
    body.append(seriesSel);

    const countHint = el('p', 'cover-pick-hint', '');
    body.append(countHint);

    const refreshChannels = () => {
      const ed = editorialSel.value;
      let chs = lib.slice();
      if (ed) chs = chs.filter((c) => String(c.group || '') === ed);
      fillSelect(
        channelSel,
        chs.map((c) => ({
          value: String(c.id),
          label: (typeof channelDisplayName === 'function' ? channelDisplayName(c) : c.name) || c.name || c.id,
        })),
        'Todas'
      );
      seriesSel.replaceChildren();
      fillSelect(seriesSel, [], 'Todas');
      updateCount();
    };

    const refreshSeries = async () => {
      const chId = channelSel.value;
      fillSelect(seriesSel, [], 'Todas');
      if (!chId) {
        updateCount();
        return;
      }
      const ch = lib.find((c) => String(c.id) === chId);
      if (!ch) return;
      let files = [];
      try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) {}
      const groups = groupSeries(files, ch.name, seriesOverrideFor?.(ch));
      fillSelect(
        seriesSel,
        groups.map((g) => ({
          value: g.label,
          label: (typeof seriesDisplayName === 'function' ? seriesDisplayName(ch, g.label) : g.label) || g.label,
        })),
        'Todas'
      );
      updateCount();
    };

    let countTimer = null;
    const updateCount = () => {
      if (countTimer) clearTimeout(countTimer);
      countTimer = setTimeout(async () => {
        countHint.textContent = 'Contando…';
        try {
          const t = await collectTargets({
            editorial: editorialSel.value,
            channelId: channelSel.value,
            seriesLabel: seriesSel.value,
          });
          countHint.textContent = t.length
            ? `${t.length} cómic(s) en el alcance seleccionado`
            : 'Ningún cómic en este alcance';
        } catch {
          countHint.textContent = '';
        }
      }, 200);
    };

    editorialSel.onchange = () => { refreshChannels(); };
    channelSel.onchange = () => { refreshSeries(); };
    seriesSel.onchange = () => { updateCount(); };
    refreshChannels();

    const structLab = el('label', 'cfg-auto');
    structLab.style.display = 'flex';
    structLab.style.alignItems = 'flex-start';
    structLab.style.gap = '0.45rem';
    structLab.style.margin = '0.75rem 0 0.5rem';
    const structChk = el('input');
    structChk.type = 'checkbox';
    structChk.checked = false;
    structLab.append(
      structChk,
      document.createTextNode('Recargar portadas de Canales, Series y Editoriales')
    );
    body.append(structLab);
    body.append(el('p', 'cfg-hint',
      'Si está marcado, tras los cómics se regeneran también portadas de canal, serie y editorial del alcance. Las personalizadas se vuelven a aplicar; la resolución sigue los checks de «Generar portadas con esta resolución» (Cómics no aplica aquí: Series / Canales; editoriales usan la de Canales).'
    ));

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => frame.remove();
    const go = el('button', 'btn edit-save', 'Borrar y regenerar');
    go.type = 'button';
    go.onclick = async () => {
      const filters = {
        editorial: editorialSel.value,
        channelId: channelSel.value,
        seriesLabel: seriesSel.value,
      };
      const targets = await collectTargets(filters);
      if (!targets.length) {
        await appAlert('No hay cómics en el alcance seleccionado.', 'Portadas');
        return;
      }
      let adaptN = 0, fixedN = 0;
      for (const t of targets) {
        const k = await customKind(t);
        if (k === 'adapt') adaptN++; else if (k === 'fixed') fixedN++;
      }
      const ok = await appConfirm(
        `Se borrarán y regenerarán ${targets.length - fixedN} portada(s).`
        + (adaptN ? `\n${adaptN} personalizada(s) se regenerarán con la misma página y recorte elegidos.` : '')
        + (fixedN ? `\n${fixedN} personalizada(s) sin datos para regenerarse se mantendrán tal cual.` : '')
        + `\nEsto puede tardar varios minutos y usar datos. ¿Continuar?`,
        'Recargar portadas'
      );
      if (!ok) return;
      frame.remove();

      const CONC = 3;
      const prog = showProgressFrame('Borrando portadas', { slots: CONC });
      prog.setStatus('Eliminando de la caché…');
      let deleted = 0;
      try {
        deleted = await deleteCoverKeys(targets, (done, total) => {
          if (prog.cancelled) return;
          prog.setProgress(done, total);
          prog.setStatus(`Borrando portadas… ${done}/${total}`);
        });
      } catch (e) {
        prog.close();
        prog.restoreTitle();
        await appAlert('Error al borrar: ' + (e?.message || e), 'Portadas');
        return;
      }
      if (prog.cancelled) {
        prog.close();
        prog.restoreTitle();
        await appAlert(`Cancelado tras borrar ${deleted} portada(s).`, 'Portadas');
        try { onCoversChanged?.(); } catch (_) {}
        return;
      }

      prog.setTitle('Regenerando portadas');
      prog.setStatus('Regenerando portadas…');
      prog.setProgress(0, targets.length);

      let regenerated = 0;
      try {
        regenerated = await regenerateCovers(targets, (done, total) => {
          if (prog.cancelled) return;
          prog.setProgress(done, total);
          prog.setStatus(`Generando portadas… ${done}/${total}`);
        }, prog);
      } catch (e) {
        prog.close();
        prog.restoreTitle();
        await appAlert(
          `Borradas: ${deleted}. Error al regenerar: ` + (e?.message || e),
          'Portadas'
        );
        try { onCoversChanged?.(); } catch (_) {}
        return;
      }
      if (prog.cancelled) {
        prog.close();
        prog.restoreTitle();
        try { onCoversChanged?.(); } catch (_) {}
        await appAlert(`Cancelado.\nBorradas: ${deleted}\nRegeneradas: ${regenerated}`, 'Portadas');
        return;
      }

      let structMsg = '';
      if (structChk.checked && typeof reloadStructureCovers === 'function') {
        try {
          prog.setTitle('Canales / Series / Editoriales');
          prog.setStatus('Regenerando portadas de estructura…');
          prog.setProgress(0, 1);
          const st = await reloadStructureCovers(filters, (done, total, label) => {
            if (prog.cancelled) return;
            prog.setProgress(done, total);
            prog.setStatus(label ? String(label).slice(0, 80) : `Estructura… ${done}/${total}`);
          });
          structMsg = `\nCanales/Series/Editoriales: ${st?.ok || 0} ok`
            + (st?.fail ? `, ${st.fail} fallos` : '');
        } catch (e) {
          structMsg = '\nEstructura: error ' + (e?.message || e);
        }
      }

      const wasBg = prog.background;
      prog.close();
      prog.restoreTitle();
      try { onCoversChanged?.(); } catch (_) {}
      const summary =
        `Listo.\nBorradas: ${deleted}\nRegeneradas: ${regenerated}`
        + (targets.keep?.length ? `\nPersonalizadas mantenidas: ${targets.keep.length}` : '')
        + structMsg;
      if (!wasBg) await appAlert(summary, 'Portadas');
      else {
        try {
          const te = appTitleEl();
          if (te) {
            te.textContent = `Portadas: ${regenerated} regeneradas`;
            setTimeout(() => { try { prog.restoreTitle(); } catch (_) {} }, 4000);
          }
        } catch (_) {}
      }
    };
    actions.append(cancel, go);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }


  function formatBytes(n) {
    const x = Number(n) || 0;
    if (x < 1024) return x + ' B';
    if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
    return (x / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function blobDims(blob) {
    return new Promise((resolve) => {
      if (!(blob instanceof Blob) || !blob.size) return resolve(null);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const done = (w, h) => {
        try { URL.revokeObjectURL(url); } catch (_) {}
        resolve(w && h ? { w, h } : null);
      };
      img.onload = () => done(img.naturalWidth, img.naturalHeight);
      img.onerror = () => done(0, 0);
      img.src = url;
    });
  }

  function classifyType(blob) {
    const t = String(blob?.type || '').toLowerCase();
    if (t.includes('webp')) return 'webp';
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpeg';
    if (t.includes('png')) return 'png';
    if (t.includes('gif')) return 'gif';
    if (t.includes('avif')) return 'avif';
    if (!t) return 'sin-tipo';
    return 'otros';
  }

  /** Analiza claves c: en IndexedDB (portadas de cómics). */
  async function analyzeCoverCache(onProgress) {
    const entries = await kv.entries();
    const covers = entries.filter(([k, v]) => String(k).startsWith('c:') && v && v !== 'none');
    const byFmt = {};
    const dimCount = new Map();
    const items = [];
    let i = 0;
    const total = covers.length;
    for (const [key, val] of covers) {
      i++;
      if (onProgress && (i % 10 === 0 || i === total)) onProgress(i, total);
      const blob = val instanceof Blob ? val : (val?.blob instanceof Blob ? val.blob : null);
      if (!blob || !blob.size) continue;
      const fmt = classifyType(blob);
      if (!byFmt[fmt]) byFmt[fmt] = { count: 0, bytes: 0 };
      byFmt[fmt].count++;
      byFmt[fmt].bytes += blob.size;
      let dims = null;
      try { dims = await blobDims(blob); } catch (_) {}
      if (dims) {
        const dk = dims.w + '×' + dims.h;
        dimCount.set(dk, (dimCount.get(dk) || 0) + 1);
      }
      items.push({
        key,
        size: blob.size,
        fmt,
        w: dims?.w || 0,
        h: dims?.h || 0,
      });
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    items.sort((a, b) => b.size - a.size);
    const dimsList = [...dimCount.entries()].sort((a, b) => b[1] - a[1]);
    const allW = items.filter((x) => x.w).map((x) => x.w);
    const allH = items.filter((x) => x.h).map((x) => x.h);
    return {
      total: items.length,
      byFmt,
      dimMin: allW.length ? { w: Math.min(...allW), h: Math.min(...allH) } : null,
      dimMax: allW.length ? { w: Math.max(...allW), h: Math.max(...allH) } : null,
      dimMode: dimsList[0] ? { label: dimsList[0][0], count: dimsList[0][1] } : null,
      dimTop: dimsList.slice(0, 8),
      largest: items.slice(0, 20),
    };
  }


  async function collectTelegramMembership() {
    const out = {
      channels: 0,
      supergroups: 0,
      groups: 0,
      users: 0,
      dialogs: 0,
      error: null,
    };
    try {
      const ready = getReady();
      if (ready && typeof ready.then === 'function') await ready;
      const client = getClient();
      if (!client) {
        out.error = 'Sin cliente Telegram';
        return out;
      }
      let dialogs = [];
      if (typeof client.getDialogs === 'function') {
        dialogs = await client.getDialogs({ limit: 200 });
        let guard = 0;
        while (dialogs.length >= 200 * (guard + 1) && guard < 8) {
          guard++;
          try {
            const last = dialogs[dialogs.length - 1];
            const more = await client.getDialogs({
              limit: 200,
              offsetDate: last?.message?.date || 0,
            });
            if (!more?.length) break;
            const seen = new Set(dialogs.map((d) => String(d.id ?? d.entity?.id)));
            let added = 0;
            for (const d of more) {
              const id = String(d.id ?? d.entity?.id);
              if (seen.has(id)) continue;
              seen.add(id);
              dialogs.push(d);
              added++;
            }
            if (!added) break;
          } catch (_) { break; }
        }
      }
      out.dialogs = dialogs.length;
      for (const d of dialogs) {
        const e = d.entity || d;
        const cn = e?.className || e?.constructor?.name || '';
        if (cn === 'Channel' || e?.broadcast != null || e?.megagroup != null) {
          if (e.broadcast) out.channels++;
          else if (e.megagroup) out.supergroups++;
          else out.channels++;
        } else if (cn === 'Chat') out.groups++;
        else if (cn === 'User') out.users++;
      }
    } catch (e) {
      out.error = e?.message || String(e);
    }
    return out;
  }

  /** Desglose biblioteca TGComic: editoriales → canales → series → nº cómics */
  async function collectLibraryBreakdown() {
    const lib = getLIB();
    const byEd = new Map(); // editorial -> { channels: [{ name, series: [{label, count}], comics }] }
    let totalChannels = 0;
    let totalSeries = 0;
    let totalComics = 0;

    for (const ch of lib || []) {
      if (!ch?.id) continue;
      totalChannels++;
      const ed = String(ch.group || 'Sin editorial').trim() || 'Sin editorial';
      if (!byEd.has(ed)) byEd.set(ed, []);
      let files = [];
      try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) { files = []; }
      if (!Array.isArray(files)) files = [];
      // aplanar versiones si vienen agrupadas
      const flat = [];
      for (const f of files) {
        if (f?.variants && typeof f.variants === 'object') {
          flat.push(f);
          for (const v of Object.values(f.variants)) if (v && v.id) flat.push(v);
        } else flat.push(f);
      }
      // usar listado tal cual para groupSeries (como en la UI)
      const groups = typeof groupSeries === 'function'
        ? groupSeries(files, ch.name, typeof seriesOverrideFor === 'function' ? seriesOverrideFor(ch) : null)
        : [{ label: '', files }];
      const seriesList = [];
      let chComics = 0;
      for (const g of groups || []) {
        const n = Array.isArray(g.files) ? g.files.length : 0;
        chComics += n;
        const label = String(g.label || g.series || '(sin serie)').trim() || '(sin serie)';
        seriesList.push({ label, count: n });
        totalSeries++;
      }
      totalComics += chComics;
      const chName = (typeof channelDisplayName === 'function' ? channelDisplayName(ch) : null) || ch.name || String(ch.id);
      byEd.get(ed).push({
        name: chName,
        id: String(ch.id),
        comics: chComics,
        series: seriesList.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
      });
    }

    // ordenar editoriales y canales
    const editorials = [...byEd.entries()]
      .map(([ed, channels]) => ({
        name: (typeof groupDisplayName === 'function' ? groupDisplayName(ed) : null) || ed,
        key: ed,
        channels: channels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
        series: channels.reduce((s, c) => s + c.series.length, 0),
        comics: channels.reduce((s, c) => s + c.comics, 0),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return {
      totalChannels,
      totalSeries,
      totalComics,
      editorials,
    };
  }

  function showDevCoverInfo() {
    document.querySelector('.info-frame.protools-dev')?.remove();
    const frame = el('div', 'info-frame protools-dev');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    const titleSpan = el('span', 'info-head-title', 'Info desarrollo');
    titleSpan.title = 'Pulsa para copiar';
    head.append(titleSpan);
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    titleSpan.onclick = (ev) => {
      ev.stopPropagation();
      try {
        if (typeof copyInfoFrameText === 'function') copyInfoFrameText(body);
        else {
          const text = body.innerText || body.textContent || '';
          navigator.clipboard?.writeText?.(text);
        }
      } catch (_) {}
      titleSpan.textContent = 'Copiado';
      setTimeout(() => { titleSpan.textContent = 'Info desarrollo'; }, 1200);
    };
    const loading = el('p', 'cover-pick-hint', 'Analizando…');
    body.append(loading);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);

    (async () => {
      try {
        const data = await analyzeCoverCache((done, tot) => {
          loading.textContent = `Analizando… ${done}/${tot}`;
        });
        body.replaceChildren();
        body.append(el('div', 'info-sec', 'Resumen'));
        const row = (lab, val) => {
          const r = el('div', 'info-row');
          r.append(el('span', 'info-label', lab), el('span', 'info-value', String(val ?? '—')));
          return r;
        };
        body.append(row('Portadas en caché', data.total));

        body.append(el('div', 'info-sec', 'Por formato'));
        const order = ['webp', 'jpeg', 'png', 'gif', 'avif', 'sin-tipo', 'otros'];
        const fmts = Object.keys(data.byFmt).sort((a, b) => {
          const ia = order.indexOf(a); const ib = order.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        if (!fmts.length) body.append(el('p', 'cover-pick-hint', 'Sin datos de formato'));
        for (const f of fmts) {
          const s = data.byFmt[f];
          body.append(row(
            f.toUpperCase(),
            `${s.count} · ${formatBytes(s.bytes)}`
          ));
        }

        body.append(el('div', 'info-sec', 'Dimensiones'));
        if (data.dimMin) {
          body.append(row('Mínimas', `${data.dimMin.w}×${data.dimMin.h}`));
          body.append(row('Máximas', `${data.dimMax.w}×${data.dimMax.h}`));
        } else {
          body.append(el('p', 'cover-pick-hint', 'No se pudieron leer dimensiones'));
        }
        if (data.dimMode) {
          body.append(row('Más frecuentes', `${data.dimMode.label} (${data.dimMode.count}×)`));
        }
        if (data.dimTop?.length > 1) {
          const extra = data.dimTop.slice(1, 5).map(([lab, n]) => `${lab} (${n})`).join(', ');
          if (extra) body.append(row('Otras frecuentes', extra));
        }

        body.append(el('div', 'info-sec', 'Top 20 más pesadas'));
        if (!data.largest.length) {
          body.append(el('p', 'cover-pick-hint', 'Ninguna'));
        } else {
          for (const it of data.largest) {
            const dim = it.w ? `${it.w}×${it.h}` : '?';
            body.append(row(
              it.key,
              `${formatBytes(it.size)} · ${it.fmt} · ${dim}`
            ));
          }
        }

        // —— Telegram Global + Biblioteca ——
        loading.textContent = 'Consultando Telegram y biblioteca…';
        body.append(el('div', 'info-sec', 'Telegram Global'));
        try {
          const tg = await collectTelegramMembership();
          if (tg?.error) {
            body.append(row('Estado', 'No se pudo consultar: ' + String(tg.error).slice(0, 120)));
          } else {
            body.append(row('Canales a los que perteneces', tg.channels ?? 0));
            body.append(row('Supergrupos a los que perteneces', tg.supergroups ?? 0));
            body.append(row('Grupos básicos', tg.groups ?? 0));
            body.append(row('Diálogos totales (aprox.)', tg.dialogs ?? 0));
            const joined = (Number(tg.channels) || 0) + (Number(tg.supergroups) || 0) + (Number(tg.groups) || 0);
            body.append(row('Canales + grupos unidos', joined + ' / ~500 (límite habitual de unión)'));
          }
        } catch (e) {
          body.append(row('Estado', 'Error: ' + (e?.message || e)));
        }

        body.append(el('div', 'info-sec', 'Telegram Biblioteca'));
        try {
          const lib = await collectLibraryBreakdown();
          body.append(row('Canales de la biblioteca', lib.totalChannels));
          body.append(row('Series (en todos los canales)', lib.totalSeries));
          body.append(row('Cómics listados', lib.totalComics));

          for (const ed of lib.editorials || []) {
            body.append(el('div', 'info-sec', 'Editorial: ' + ed.name));
            body.append(row('Canales', ed.channels.length));
            body.append(row('Series', ed.series));
            body.append(row('Cómics', ed.comics));
            for (const ch of ed.channels) {
              body.append(el('p', 'cover-pick-hint',
                'Canal: ' + ch.name + ' · ' + ch.series.length + ' serie(s) · ' + ch.comics + ' cómic(s)'
              ));
              for (const s of ch.series) {
                body.append(el('p', 'cover-pick-hint',
                  '  · ' + s.label + ' — ' + s.count + ' cómic(s)'
                ));
              }
            }
          }
          if (!(lib.editorials || []).length) {
            body.append(el('p', 'cover-pick-hint', 'Biblioteca vacía o aún no sincronizada.'));
          }
        } catch (e) {
          body.append(row('Biblioteca', 'Error: ' + (e?.message || e)));
        }

        const actions = el('div', 'edit-actions');
        const btnClose = el('button', 'btn', 'Cerrar');
        btnClose.onclick = () => frame.remove();
        actions.append(btnClose);
        body.append(actions);
      } catch (e) {
        loading.textContent = 'Error: ' + (e?.message || e);
      }
    })();
  }


  /** Todos los cómics listados en caché (f:canal). */
  async function collectAllComics() {
    const out = [];
    for (const ch of getLIB()) {
      let files = [];
      try { files = (await kv.get('f:' + ch.id)) || []; } catch (_) { files = []; }
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        if (!f || f.id == null) continue;
        out.push({ ch, f });
      }
    }
    return out;
  }

  async function loadMissingCovers() {
    try { closeAppMenu?.(); } catch (_) {}
    // Feedback inmediato: el escaneo de IndexedDB puede tardar y parecía que no hacía nada
    const scanProg = showProgressFrame('Cargar portadas faltantes');
    scanProg.setStatus('Escaneando cómics en caché…');
    scanProg.setProgress(0, 1);
    let all = [];
    try {
      all = await collectAllComics();
    } catch (e) {
      try { scanProg.close(); } catch (_) {}
      await appAlert('Error al listar cómics: ' + (e?.message || e));
      return;
    }
    const missing = [];
    const nAll = all.length || 1;
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      const key = `c:${it.ch.id}:${it.f.id}`;
      let b = null;
      try { b = await kv.get(key); } catch (_) {}
      if (!b || b === 'none') missing.push(it);
      if (i % 25 === 0 || i === all.length - 1) {
        scanProg.setStatus(`Escaneando… ${i + 1}/${all.length}`);
        scanProg.setProgress(i + 1, nAll);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    try { scanProg.close(); } catch (_) {}
    const ok = await appConfirm(
      (missing.length
        ? `Hay ${missing.length} cómic(s) sin portada en caché.`
        : 'Todos los cómics tienen portada en caché.')
      + ' También se recuperarán las portadas personalizadas de canales y series. ¿Continuar? (puede tardar)',
      'Cargar portadas faltantes'
    );
    if (!ok) return;
    const CONCURRENCY = 3;
    const prog = showProgressFrame('Cargar portadas faltantes', { slots: CONCURRENCY });
    let done = 0, okN = 0, fail = 0, skip = 0;
    prog.setProgress(0, missing.length || 1);
    prog.setStatus('Generando portadas…');
    // CBZ (ZIP por trozos) suele ser rápido; CBR descarga el archivo entero → más margen
    const isCbr = (f) => /\.cbr$/i.test(String(f?.name || ''));
    const timeoutFor = (f) => (isCbr(f) || /\.pdf$/i.test(String(f?.name || ''))) ? 75000 : 35000;
    const withTimeout = (p, ms) => {
      let t;
      const timeout = new Promise((_, rej) => {
        t = setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms);
      });
      return Promise.race([p, timeout]).finally(() => { try { clearTimeout(t); } catch (_) {} });
    };
    const gen = typeof generateCover === 'function' ? generateCover : null;
    let next = 0;
    const total = missing.length;
    const worker = async () => {
      while (true) {
        if (prog.cancelled) return;
        const i = next++;
        if (i >= total) return;
        const { ch, f } = missing[i];
        const label = String(f.name || f.id || '').slice(0, 60);
        const slot = prog.acquireSlot();
        const setDetail = (t) => {
          if (slot >= 0) prog.setSlot(slot, label, t || '');
        };
        setDetail(isCbr(f) ? 'CBR (descarga completa)…' : 'En cola…');
        try {
          if (prog.cancelled) break;
          let b = null;
          if (gen) {
            b = await withTimeout(
              gen(ch, f, { status: (t) => setDetail(String(t || '')) }),
              timeoutFor(f)
            );
          } else if (typeof getCover === 'function') {
            b = await withTimeout(getCover(ch, f), timeoutFor(f));
          }
          if (b) okN++;
          else fail++;
        } catch (e) {
          if (e?.timeout) {
            skip++;
            setDetail('Omitido (timeout)');
          } else {
            fail++;
            setDetail('Error');
          }
        }
        if (slot >= 0) prog.releaseSlot(slot);
        done++;
        prog.setProgress(done, total);
        if (prog.cancelled) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));
    if (prog.cancelled) {
      prog.close();
      prog.restoreTitle();
      try { onCoversChanged?.(); } catch (_) {}
      await appAlert(
        `Cancelado.\nCompletadas: ${okN}` + (fail ? `, fallos: ${fail}` : '') + (skip ? `, omitidas: ${skip}` : '') + '.',
        'Portadas'
      );
      return;
    }
    let custom = { ok: 0, fail: 0, total: 0 };
    if (typeof d.restoreCustomCovers === 'function') {
      prog.setStatus('Portadas personalizadas de canales y series…');
      try {
        custom = (await d.restoreCustomCovers((t) => prog.setStatus(String(t).slice(0, 80)))) || custom;
      } catch (_) {}
    }
    const wasBg = prog.background;
    prog.close();
    prog.restoreTitle();
    try { onCoversChanged?.(); } catch (_) {}
    const summary =
      `Portadas de cómics: ${okN} cargadas`
      + (fail ? `, ${fail} sin imagen` : '')
      + (skip ? `, ${skip} omitidas (timeout)` : '') + '.'
      + `\nPortadas personalizadas: ${custom.ok} recuperadas` + (custom.fail ? `, ${custom.fail} fallidas` : '') + '.';
    if (!wasBg) await appAlert(summary, 'Portadas');
    else {
      try {
        const te = appTitleEl();
        if (te) {
          te.textContent = `Portadas: ${okN} ok` + (fail || skip ? ` · ${fail + skip} fallos` : '');
          setTimeout(() => { try { prog.restoreTitle(); } catch (_) {} }, 4000);
        }
      } catch (_) {}
    }
  }

  async function countPagesForComic(ch, f) {
    if (typeof openPages !== 'function' || typeof getMsg !== 'function') return 0;
    const ac = { aborted: false };
    let closer = null;
    try {
      const msg = await getMsg(ch, f);
      if (!msg) return 0;
      const status = () => {};
      const pack = await openPages(msg, f.size, status, ac);
      closer = pack?.close;
      const n = Array.isArray(pack?.pages) ? pack.pages.length : 0;
      return n > 0 ? n : 0;
    } catch (_) {
      return 0;
    } finally {
      try { await closer?.(); } catch (_) {}
    }
  }

  async function loadMissingPageCounts() {
    try { closeAppMenu?.(); } catch (_) {}
    const all = await collectAllComics();
    const missing = [];
    for (const it of all) {
      const tot = typeof getPagesTotal === 'function'
        ? getPagesTotal(it.ch.id, it.f.id)
        : 0;
      if (!(tot > 0)) missing.push(it);
    }
    if (!missing.length) {
      await appAlert('Todos los cómics listados ya tienen número de páginas guardado.', 'Páginas');
      return;
    }
    const ok = await appConfirm(
      `Hay ${missing.length} cómic(s) sin número de páginas. ¿Contarlos ahora? (descarga cada archivo; puede tardar mucho)`,
      'Cargar número de páginas'
    );
    if (!ok) return;
    const prog = showProgressFrame('Cargar número de páginas', { slots: 1 });
    let done = 0, okN = 0, fail = 0;
    prog.setProgress(0, missing.length);
    for (const { ch, f } of missing) {
      if (prog.cancelled) break;
      const label = String(f.name || f.id || '').slice(0, 60);
      const slot = prog.acquireSlot();
      if (slot >= 0) prog.setSlot(slot, label, 'Contando páginas…');
      else prog.setStatus(label);
      try {
        const n = await countPagesForComic(ch, f);
        if (n > 0 && typeof setPagesTotal === 'function') {
          setPagesTotal(ch.id, f.id, n);
          okN++;
          if (slot >= 0) prog.setSlot(slot, label, n + ' páginas');
        } else {
          fail++;
          if (slot >= 0) prog.setSlot(slot, label, 'Sin páginas');
        }
      } catch (_) {
        fail++;
        if (slot >= 0) prog.setSlot(slot, label, 'Error');
      }
      if (slot >= 0) prog.releaseSlot(slot);
      done++;
      prog.setProgress(done, missing.length);
      if (done % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const wasBg = prog.background;
    const cancelled = prog.cancelled;
    prog.close();
    prog.restoreTitle();
    try { onCoversChanged?.(); } catch (_) {}
    const summary = (cancelled ? 'Cancelado. ' : '')
      + `Páginas: ${okN} actualizados` + (fail ? `, ${fail} fallidos` : '') + '.';
    if (!wasBg) await appAlert(summary, 'Páginas');
  }


  function showImageConfig() {
    document.querySelector('.info-frame.img-cfg')?.remove();
    const frame = el('div', 'info-frame img-cfg');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Configuración Imágenes y Textos'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      'Solo este dispositivo. No afecta a editoriales de la home.'
    ));

    const applyNow = () => {
      try {
        if (typeof window.applyCoverSizePrefs === 'function') window.applyCoverSizePrefs();
        else if (typeof applyCoverSizePrefs === 'function') applyCoverSizePrefs();
      } catch (_) {}
      try { onCoversChanged?.(); } catch (_) {}
    };

    const field = (parent, label, hint, inp) => {
      const row = el('div', 'cfg-row');
      row.append(el('label', 'sync-label', label));
      row.append(el('p', 'cfg-hint', hint));
      row.append(inp);
      parent.append(row);
    };

    const block = (title, coverKey, textKey, coverDef, textDef, autoKey, genKey) => {
      const boxB = el('div', 'cfg-block');
      boxB.append(el('div', 'info-sec', title));

      const inpH = el('input', 'edit-input');
      inpH.type = 'number';
      inpH.min = '100';
      inpH.max = '400';
      inpH.step = '5';
      let curH = Math.max(100, Math.min(400, +(devPref(coverKey, String(coverDef)) || coverDef)));
      inpH.value = String(curH);
      const hintH = () => 'Actual: ' + inpH.value + ' px · por defecto ' + coverDef;
      const hintHEl = el('p', 'cfg-hint', hintH());
      inpH.oninput = () => {
        const v = Math.max(100, Math.min(400, +inpH.value || coverDef));
        hintHEl.textContent = 'Actual: ' + v + ' px · por defecto ' + coverDef;
      };
      inpH.onchange = () => {
        const v = Math.max(100, Math.min(400, +inpH.value || coverDef));
        inpH.value = String(v);
        setDevPref(coverKey, String(v));
        hintHEl.textContent = hintH();
        applyNow();
      };
      const rowH = el('div', 'cfg-row');
      rowH.append(el('label', 'sync-label', 'Altura de portada (px)'));
      rowH.append(hintHEl);
      rowH.append(inpH);
      boxB.append(rowH);

      if (genKey) {
        const genLab = el('label', 'cfg-auto');
        genLab.style.display = 'flex';
        genLab.style.alignItems = 'center';
        genLab.style.gap = '0.4rem';
        genLab.style.margin = '0.35rem 0 0.5rem';
        const genChk = el('input');
        genChk.type = 'checkbox';
        genChk.checked = devPref(genKey, '0') === '1';
        genChk.onchange = () => {
          setDevPref(genKey, genChk.checked ? '1' : '0');
        };
        genLab.append(genChk, document.createTextNode('Generar portadas con esta resolución'));
        boxB.append(genLab);
        boxB.append(el('p', 'cfg-hint',
          'Si está marcado, al crear o regenerar portadas de este tipo se limita el lado mayor a la altura configurada arriba.'
        ));
      }

      const inpT = el('input', 'edit-input');
      inpT.type = 'number';
      inpT.min = '8';
      inpT.max = '32';
      inpT.step = '1';
      let curT = Math.max(8, Math.min(32, +(devPref(textKey, String(textDef)) || textDef)));
      inpT.value = String(curT);
      const hintT = () => 'Actual: ' + inpT.value + ' px · por defecto ' + textDef;
      const hintTEl = el('p', 'cfg-hint', hintT());
      inpT.oninput = () => {
        const v = Math.max(8, Math.min(32, +inpT.value || textDef));
        hintTEl.textContent = 'Actual: ' + v + ' px · por defecto ' + textDef;
      };
      inpT.onchange = () => {
        const v = Math.max(8, Math.min(32, +inpT.value || textDef));
        inpT.value = String(v);
        setDevPref(textKey, String(v));
        hintTEl.textContent = hintT();
        applyNow();
      };
      const rowT = el('div', 'cfg-row');
      const headT = el('div', 'cfg-row-head');
      headT.append(el('label', 'sync-label', 'Tamaño del texto (px)'));
      const autoLab = el('label', 'cfg-auto');
      const autoChk = el('input');
      autoChk.type = 'checkbox';
      autoChk.checked = devPref(autoKey, '0') === '1';
      autoChk.onchange = () => {
        setDevPref(autoKey, autoChk.checked ? '1' : '0');
        applyNow();
      };
      autoLab.append(autoChk, document.createTextNode('Ajustar Automáticamente'));
      headT.append(autoLab);
      rowT.append(headT);
      rowT.append(hintTEl);
      rowT.append(inpT);
      boxB.append(rowT);

      body.append(boxB);
    };

    block('Cómics', 'coverHComic', 'coverTextComic', 225, 15, 'textAutoComic', 'coverGenAtResComic');
    block('Series', 'coverHSeries', 'coverTextSeries', 225, 15, 'textAutoSeries', 'coverGenAtResSeries');
    block('Canales', 'coverHChannel', 'coverTextChannel', 225, 15, 'textAutoChannel', 'coverGenAtResChannel');

    const actions = el('div', 'edit-actions');
    const reset = el('button', 'btn', 'Restaurar valores');
    reset.onclick = () => {
      setDevPref('coverHComic', '225');
      setDevPref('coverHSeries', '225');
      setDevPref('coverHChannel', '225');
      setDevPref('coverTextComic', '15');
      setDevPref('coverTextSeries', '15');
      setDevPref('coverTextChannel', '15');
      setDevPref('textAutoComic', '0');
      setDevPref('textAutoSeries', '0');
      setDevPref('textAutoChannel', '0');
      setDevPref('coverGenAtResComic', '0');
      setDevPref('coverGenAtResSeries', '0');
      setDevPref('coverGenAtResChannel', '0');
      applyNow();
      frame.remove();
      showImageConfig();
    };
    const done = el('button', 'btn edit-save', 'Listo');
    done.onclick = () => frame.remove();
    actions.append(reset, done);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }


  function getGridLayout() {
    try {
      const v = devPref('gridLayout', 'fill');
      return v === 'fixed' ? 'fixed' : 'fill';
    } catch (_) { return 'fill'; }
  }
  function setGridLayout(mode) {
    const m = mode === 'fixed' ? 'fixed' : 'fill';
    try { setDevPref('gridLayout', m); } catch (_) {}
    try {
      if (typeof d.applyGridLayoutPref === 'function') d.applyGridLayoutPref();
      else if (typeof window.applyGridLayoutPref === 'function') window.applyGridLayoutPref();
      else document.documentElement.setAttribute('data-grid-layout', m);
    } catch (_) {}
  }

  function showGridConfig() {
    try { closeAppMenu?.(); } catch (_) {}
    document.querySelector('.info-frame.grid-config')?.remove();
    const frame = el('div', 'info-frame grid-config');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Configuración de rejillas'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      'Solo este dispositivo. No se sincroniza entre aparatos.'
    ));
    body.append(el('div', 'info-sec', 'Tipo de rejilla'));

    const wrap = el('div', 'cfg-group');
    const btns = [];
    const paint = () => {
      const cur = getGridLayout();
      btns.forEach(({ b, val }) => b.classList.toggle('on', val === cur));
    };
    const options = [
      {
        val: 'fill',
        label: 'Llenar ancho',
        desc: 'Las portadas crecen para ocupar todo el ancho disponible. Casi no hay huecos a los lados. En pantallas grandes se ven más grandes.',
      },
      {
        val: 'fixed',
        label: 'Tamaño fijo (centrado)',
        desc: 'Las portadas mantienen el tamaño configurado. El espacio sobrante va a los lados. La distancia entre portadas es siempre la misma.',
      },
    ];
    for (const opt of options) {
      const b = el('button', 'cfg-toggle', opt.label);
      b.type = 'button';
      b.onclick = () => { setGridLayout(opt.val); paint(); };
      btns.push({ b, val: opt.val });
      wrap.append(b);
      const hint = el('p', 'cfg-hint', opt.desc);
      hint.style.whiteSpace = 'normal';
      hint.style.overflow = 'visible';
      hint.style.textOverflow = 'unset';
      hint.style.margin = '0.25rem 0 0.85rem';
      wrap.append(hint);
    }
    body.append(wrap);
    paint();

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cerrar');
    cancel.onclick = () => frame.remove();
    actions.append(cancel);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }

  /** Menú Configuración Avanzada */
  function showAdvancedConfig() {
    try { closeAppMenu?.(); } catch (_) {}
    document.querySelector('.info-frame.adv-config')?.remove();
    const frame = el('div', 'info-frame adv-config');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Configuración Avanzada'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      'Herramientas de mantenimiento de la caché local.'
    ));

    const imgCfgBtn = el('button', 'btn cover-pick-device', 'Configuración Imágenes y Textos');
    imgCfgBtn.type = 'button';
    imgCfgBtn.onclick = () => {
      try {
        frame.remove();
        showImageConfig();
      } catch (err) {
        console.error('[img-cfg]', err);
        try { appAlert('No se pudo abrir Configuración Imágenes: ' + (err?.message || err)); } catch (_) {}
      }
    };
    body.append(imgCfgBtn);

    const gridCfgBtn = el('button', 'btn cover-pick-device', 'Configuración de rejillas');
    gridCfgBtn.type = 'button';
    gridCfgBtn.onclick = () => {
      try {
        frame.remove();
        showGridConfig();
      } catch (err) {
        console.error('[grid-cfg]', err);
        try { appAlert('No se pudo abrir Configuración de rejillas: ' + (err?.message || err)); } catch (_) {}
      }
    };
    body.append(gridCfgBtn);

    const reloadCoversBtn = el('button', 'btn protools-accent', 'Recargar portadas');
    reloadCoversBtn.type = 'button';
    reloadCoversBtn.onclick = () => {
      frame.remove();
      showReloadCoversFrame();
    };
    body.append(reloadCoversBtn);

    const missingCoversBtn = el('button', 'btn cover-pick-device', 'Cargar portadas faltantes');
    missingCoversBtn.type = 'button';
    missingCoversBtn.onclick = () => {
      frame.remove();
      loadMissingCovers();
    };
    body.append(missingCoversBtn);

    const missingPagesBtn = el('button', 'btn cover-pick-device', 'Cargar número de páginas');
    missingPagesBtn.type = 'button';
    missingPagesBtn.onclick = () => {
      frame.remove();
      loadMissingPageCounts();
    };
    body.append(missingPagesBtn);

    const devBtn = el('button', 'btn cover-pick-device', 'Info desarrollo');
    devBtn.type = 'button';
    devBtn.onclick = () => {
      frame.remove();
      showDevCoverInfo();
    };
    body.append(devBtn);

    const resetReadBtn = el('button', 'btn cover-pick-device', 'Reiniciar vistos / no vistos / seguir leyendo');
    resetReadBtn.type = 'button';
    resetReadBtn.onclick = async () => {
      const ok = await appConfirm(
        'Se borrará todo el progreso de lectura local (página actual, leídos, seguir leyendo). No borra cómics ni portadas. ¿Continuar?',
        'Reiniciar progreso'
      );
      if (!ok) return;
      let n = 0;
      try {
        n = typeof clearAllReadingData === 'function' ? clearAllReadingData() : 0;
      } catch (e) {
        await appAlert('Error: ' + (e?.message || e));
        return;
      }
      try { onCoversChanged?.(); } catch (_) {}
      frame.remove();
      await appAlert(
        n ? `Progreso reiniciado (${n} claves).` : 'No había datos de progreso.',
        'Progreso'
      );
    };
    body.append(resetReadBtn);

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cerrar');
    cancel.onclick = () => frame.remove();
    actions.append(cancel);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }

  return {
    showAdvancedConfig,
    showGridConfig,
    showReloadCoversFrame,
  };
}
