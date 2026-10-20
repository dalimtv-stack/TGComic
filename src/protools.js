/**
 * Herramientas avanzadas (Configuración Avanzada).
 * - Recargar portadas con filtro Editorial / Canal / Serie
 * - Progreso de borrado y de regeneración
 */
export function createProTools(d) {
  const {
    el,
    kv,
    getCover,
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
  } = d;

  const getLIB = () => (typeof d.LIB === 'function' ? d.LIB() : d.LIB) || [];

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

  /** Pantalla de progreso (bloqueo de fondo). */
  function showProgressFrame(title) {
    document.querySelector('.info-frame.protools-progress')?.remove();
    const frame = el('div', 'info-frame protools-progress');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', title || 'Progreso'));
    box.append(head);
    const body = el('div', 'info-body');
    const status = el('p', 'cover-pick-hint', 'Preparando…');
    status.id = 'protools-status';
    const bar = el('div', 'repack-panel-bar');
    const fill = el('div', 'repack-panel-fill');
    fill.style.width = '0%';
    bar.append(fill);
    const count = el('p', 'cover-pick-hint', '');
    body.append(status, bar, count);
    box.append(body);
    frame.append(box);
    document.body.append(frame);
    return {
      frame,
      setStatus(t) { status.textContent = t; },
      setProgress(done, total) {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        fill.style.width = pct + '%';
        count.textContent = total ? `${done} / ${total} (${pct}%)` : '';
      },
      close() { try { frame.remove(); } catch (_) {} },
    };
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

  async function deleteCoverKeys(targets, onProgress) {
    let done = 0;
    const total = targets.length;
    for (const t of targets) {
      try { await kv.del(t.key); } catch (_) {}
      done++;
      if (done % 5 === 0 || done === total) onProgress?.(done, total);
      if (done % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return done;
  }

  async function regenerateCovers(targets, onProgress) {
    let done = 0;
    let okN = 0;
    const total = targets.length;
    for (const t of targets) {
      try {
        // force: no usar portada en caché ni mensaje Telegram en memoria
        if (typeof d.invalidateComicLocal === 'function') {
          try { await d.invalidateComicLocal(t.ch, t.f); } catch (_) {}
        }
        if (typeof getCover === 'function') {
          const b = await getCover(t.ch, t.f, { force: true });
          if (b) okN++;
        }
      } catch (_) {}
      done++;
      onProgress?.(done, total);
      if (done % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
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
      const ok = await appConfirm(
        `Se borrarán y regenerarán ${targets.length} portada(s).\nEsto puede tardar varios minutos y usar datos. ¿Continuar?`,
        'Recargar portadas'
      );
      if (!ok) return;
      frame.remove();

      const prog = showProgressFrame('Borrando portadas');
      prog.setStatus('Eliminando de la caché…');
      let deleted = 0;
      try {
        deleted = await deleteCoverKeys(targets, (done, total) => {
          prog.setProgress(done, total);
          prog.setStatus(`Borrando portadas… ${done}/${total}`);
        });
      } catch (e) {
        prog.close();
        await appAlert('Error al borrar: ' + (e?.message || e), 'Portadas');
        return;
      }

      prog.setStatus('Regenerando portadas…');
      prog.setProgress(0, targets.length);
      // Cambiar título visual
      try {
        const titleEl = prog.frame.querySelector('.info-head span');
        if (titleEl) titleEl.textContent = 'Regenerando portadas';
      } catch (_) {}

      let regenerated = 0;
      try {
        regenerated = await regenerateCovers(targets, (done, total) => {
          prog.setProgress(done, total);
          prog.setStatus(`Generando portadas… ${done}/${total}`);
        });
      } catch (e) {
        prog.close();
        await appAlert(
          `Borradas: ${deleted}. Error al regenerar: ` + (e?.message || e),
          'Portadas'
        );
        try { onCoversChanged?.(); } catch (_) {}
        return;
      }

      prog.close();
      try { onCoversChanged?.(); } catch (_) {}
      await appAlert(
        `Listo.\nBorradas: ${deleted}\nRegeneradas: ${regenerated}`,
        'Portadas'
      );
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

  function showDevCoverInfo() {
    document.querySelector('.info-frame.protools-dev')?.remove();
    const frame = el('div', 'info-frame protools-dev');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    const titleSpan = el('span', 'info-head-title', 'Info desarrollo · Portadas');
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
      setTimeout(() => { titleSpan.textContent = 'Info desarrollo · Portadas'; }, 1200);
    };
    const loading = el('p', 'cover-pick-hint', 'Analizando caché de portadas…');
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
    const all = await collectAllComics();
    const missing = [];
    for (const it of all) {
      const key = `c:${it.ch.id}:${it.f.id}`;
      let b = null;
      try { b = await kv.get(key); } catch (_) {}
      if (!b || b === 'none') missing.push(it);
    }
    if (!missing.length) {
      await appAlert('Todas las portadas de la biblioteca local ya están en caché.', 'Portadas');
      return;
    }
    const ok = await appConfirm(
      `Hay ${missing.length} cómic(s) sin portada en caché. ¿Descargarlas ahora? (usa Telegram; puede tardar)`,
      'Cargar portadas faltantes'
    );
    if (!ok) return;
    const prog = showProgressFrame('Cargar portadas faltantes');
    let done = 0, okN = 0, fail = 0;
    prog.setProgress(0, missing.length);
    for (const { ch, f } of missing) {
      prog.setStatus((f.name || f.id || '').slice(0, 60));
      try {
        const b = await getCover(ch, f);
        if (b) okN++;
        else fail++;
      } catch (_) { fail++; }
      done++;
      prog.setProgress(done, missing.length);
      if (done % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    prog.close();
    try { onCoversChanged?.(); } catch (_) {}
    await appAlert(
      `Portadas: ${okN} cargadas` + (fail ? `, ${fail} sin imagen` : '') + '.',
      'Portadas'
    );
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
    const prog = showProgressFrame('Cargar número de páginas');
    let done = 0, okN = 0, fail = 0;
    prog.setProgress(0, missing.length);
    for (const { ch, f } of missing) {
      prog.setStatus((f.name || f.id || '').slice(0, 60));
      try {
        const n = await countPagesForComic(ch, f);
        if (n > 0 && typeof setPagesTotal === 'function') {
          setPagesTotal(ch.id, f.id, n);
          okN++;
        } else fail++;
      } catch (_) { fail++; }
      done++;
      prog.setProgress(done, missing.length);
      if (done % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    prog.close();
    try { onCoversChanged?.(); } catch (_) {}
    await appAlert(
      `Páginas: ${okN} actualizados` + (fail ? `, ${fail} fallidos` : '') + '.',
      'Páginas'
    );
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
    showReloadCoversFrame,
  };
}
