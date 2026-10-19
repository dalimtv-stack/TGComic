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
    const total = targets.length;
    for (const t of targets) {
      try {
        if (typeof getCover === 'function') await getCover(t.ch, t.f);
      } catch (_) {}
      done++;
      onProgress?.(done, total);
      if (done % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return done;
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
