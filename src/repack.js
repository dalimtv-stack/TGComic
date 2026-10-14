/**
 * Herramienta: convertir CBR → CBZ y re-subir (también mensajes reenviados).
 * Pensado para móvil: poca RAM (streaming, un archivo a la vez, liberar buffers).
 */
import * as zip from '@zip.js/zip.js';

export function createRepackTool(d) {
  const {
    el, Api,
    kv, peerOf,
    fetchFiles, getMsg, pageBlob,
    downloadRarBytes, sniff, TgReader, pagesOf,
    natural, formatBytes,
  } = d;
  const getClient = () => d.client;
  const getReady = () => d.ready;
  const getLIB = () => d.LIB;

  let running = false;
  let abort = false;

  const isCbrName = (name) => /\.cbr$/i.test(name || '');
  const toCbzName = (name) => String(name || 'comic.cbr').replace(/\.cbr$/i, '.cbz');
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  async function downloadWholeMessage(msg, size, status) {
    const client = getClient();
    const ac = { get cancelled() { return abort; } };
    // Preferir downloadMedia (más eficiente)
    try {
      const buf = await client.downloadMedia(msg.media, {
        workers: 2,
        progressCallback: (got) => {
          if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
          const n = Number(got?.toString?.() ?? got);
          if (size > 0 && n >= 0) status(`Descargando… ${Math.min(100, Math.round((n / size) * 100))}%`);
        },
      });
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      if (buf) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        if (u8.byteLength > 0) return u8;
      }
    } catch (e) {
      if (e?.cancelled || abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      console.warn('[repack] downloadMedia, se reintenta por trozos', e);
    }
    status('Descargando por trozos…');
    return downloadRarBytes(msg, size, status, ac);
  }

  /** Si ya es ZIP: no reextraer; solo cambiar extensión al subir. */
  async function convertToCbzBlob(ch, f, status) {
    const msg = await getMsg(ch, f);
    if (!msg?.media) throw new Error('Sin media en el mensaje');

    const probe = new TgReader(msg, f.size);
    const kind = await sniff(probe);

    if (kind === 'zip') {
      status('Es ZIP (CBR falso): descarga directa…');
      const data = await downloadWholeMessage(msg, f.size, status);
      // Una sola copia → Blob; soltar referencia al buffer grande después
      const blob = new Blob([data], { type: 'application/zip' });
      status(`Listo para subir (${formatBytes?.(blob.size) || blob.size + ' B'})`);
      return blob;
    }

    // RAR real: extraer imagen a imagen y escribir CBZ sin acumular todas
    status('Descargando CBR (RAR)…');
    let data = await downloadWholeMessage(msg, f.size, status);
    if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });

    status('Extrayendo RAR → CBZ (streaming)…');
    const { createExtractorFromData } = await import('node-unrar-js');
    const rarWasm = (await import('node-unrar-js/esm/js/unrar.wasm?url')).default;
    const ab = data.buffer.byteLength === data.byteLength && data.byteOffset === 0
      ? data.buffer
      : data.slice().buffer;
    // data ya no hace falta como vista
    data = null;

    const ex = await createExtractorFromData({
      wasmBinary: await (await fetch(rarWasm)).arrayBuffer(),
      data: ab,
    });

    const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
      bufferedWrite: true,
      level: 0,
    });

    let nImg = 0;
    const mimeOf = (name) => {
      const e = (name.split(/[/\\]/).pop() || name).toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
      if (!e) return 'application/octet-stream';
      return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' })[e[1]] || 'application/octet-stream';
    };

    for (const x of ex.extract().files) {
      if (abort) {
        try { await writer.close(); } catch (_) {}
        throw Object.assign(new Error('cancelado'), { cancelled: true });
      }
      const n = x.fileHeader.name || '';
      if (x.fileHeader.flags.directory || !x.extraction) continue;
      const base = n.split(/[/\\]/).pop() || n;
      if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
      const raw = x.extraction;
      const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (!src.byteLength) continue;
      // Copia propia y soltar referencia WASM cuanto antes
      const copy = new Uint8Array(src.byteLength);
      copy.set(src);
      const pageBlob = new Blob([copy.buffer], { type: mimeOf(base) });
      nImg++;
      await writer.add(base, new zip.BlobReader(pageBlob), { level: 0 });
      status(`Empaquetando… ${nImg} img`);
      if (nImg % 2 === 0) await yieldTick();
    }

    if (!nImg) {
      try { await writer.close(); } catch (_) {}
      throw new Error('CBR sin imágenes legibles');
    }
    const out = await writer.close();
    status(`CBZ listo (${formatBytes?.(out.size) || out.size + ' B'}, ${nImg} img)`);
    return out;
  }

  async function uploadCbz(ch, fileName, blob, caption, status) {
    await getReady();
    const peer = peerOf(ch);
    const client = getClient();
    if (!blob || !blob.size) throw new Error('CBZ vacío');
    status?.(`Preparando subida… (${formatBytes?.(blob.size) || blob.size + ' B'})`);

    const attrs = [new Api.DocumentAttributeFilename({ fileName })];
    const onProgress = (sent, total) => {
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const s = Number(sent?.toString?.() ?? sent);
      const t = Number(total?.toString?.() ?? total);
      if (t > 0 && Number.isFinite(s)) {
        status?.(`Subiendo… ${Math.min(100, Math.round((s / t) * 100))}%`);
      } else if (Number.isFinite(s) && s > 0) {
        status?.(`Subiendo… ${formatBytes?.(s) || s + ' B'}`);
      }
    };

    // 1) Preferido en navegador: File/Blob (GramJS sube por partes, sin CustomFile ni Buffer)
    const browserFile = (typeof File !== 'undefined')
      ? new File([blob], fileName, { type: blob.type || 'application/zip' })
      : blob;

    try {
      status?.('Subiendo…');
      await client.sendFile(peer, {
        file: browserFile,
        caption: caption || '',
        forceDocument: true,
        workers: 1,
        attributes: attrs,
        progressCallback: onProgress,
      });
      return;
    } catch (e) {
      if (e?.cancelled || abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      console.warn('[repack] sendFile(File/Blob) falló, reintento uploadFile', e);
      status?.(`Reintento de subida… (${e?.message || e})`);
    }

    // 2) Fallback: buffer + CustomFile + uploadFile (algunas builds de GramJS)
    let buf;
    try {
      buf = new Uint8Array(await blob.arrayBuffer());
    } catch (e) {
      throw new Error('No se pudo leer el CBZ para subir: ' + (e?.message || e));
    }

    let CustomFile;
    try {
      ({ CustomFile } = await import('telegram/Utils'));
    } catch (_) {
      try { ({ CustomFile } = await import('telegram/Utils.js')); }
      catch (e2) { CustomFile = null; }
    }

    if (CustomFile) {
      try {
        const custom = new CustomFile(fileName, buf.byteLength, fileName, buf);
        const uploaded = await client.uploadFile({
          file: custom,
          workers: 1,
          onProgress: (progress) => {
            // progress 0..1 en algunas versiones
            const p = Number(progress);
            if (Number.isFinite(p) && p >= 0 && p <= 1) {
              status?.(`Subiendo… ${Math.min(100, Math.round(p * 100))}%`);
            }
          },
        });
        await client.sendFile(peer, {
          file: uploaded,
          caption: caption || '',
          forceDocument: true,
          attributes: attrs,
        });
        buf = null;
        return;
      } catch (e) {
        if (e?.cancelled || abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
        console.warn('[repack] uploadFile+CustomFile falló', e);
      }
    }

    // 3) Último recurso: sendFile con Uint8Array
    try {
      await client.sendFile(peer, {
        file: buf,
        caption: caption || '',
        forceDocument: true,
        workers: 1,
        attributes: attrs,
        progressCallback: onProgress,
      });
      buf = null;
      return;
    } catch (e) {
      if (e?.cancelled || abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      throw new Error('No se pudo subir el archivo: ' + (e?.message || e));
    }
  }

  async function deleteMessage(ch, msgId) {
    await getReady();
    try {
      await getClient().deleteMessages(peerOf(ch), [msgId], { revoke: true });
    } catch (e) {
      console.warn('[repack] delete', e);
      throw new Error('Subido OK, pero no se pudo borrar el original (¿falta permiso de admin?)');
    }
  }

  async function collectCandidates() {
    await getReady();
    const list = [];
    const channels = Array.isArray(getLIB()) ? getLIB() : [];
    for (const ch of channels) {
      let files = (await kv.get('f:' + ch.id)) || [];
      if (!files.length) {
        try { files = await fetchFiles(ch); } catch (_) { continue; }
      }
      for (const f of files) {
        const cbr = isCbrName(f.name);
        const fwd = !!f.forwarded;
        if (!cbr && !fwd) continue;
        list.push({
          ch,
          f,
          reasons: [cbr ? 'CBR' : null, fwd ? 'Reenviado' : null].filter(Boolean),
        });
      }
    }
    list.sort((a, b) => natural(a.f.name, b.f.name));
    return list;
  }

  function ensureRestoreChip() {
    let chip = document.getElementById('repack-chip');
    if (chip) return chip;
    chip = el('button', 'repack-chip', 'Recarga CBR');
    chip.id = 'repack-chip';
    chip.type = 'button';
    chip.title = 'Mostrar progreso de recarga';
    chip.onclick = () => {
      const panel = document.getElementById('repack-panel');
      if (panel) {
        panel.hidden = false;
        panel.classList.remove('minimized');
      }
      chip.hidden = true;
    };
    document.body.append(chip);
    return chip;
  }

  function showProgressPanel() {
    let panel = document.getElementById('repack-panel');
    if (panel) {
      panel.hidden = false;
      panel.classList.remove('minimized');
      const chip = document.getElementById('repack-chip');
      if (chip) chip.hidden = true;
      return panel;
    }
    panel = el('div', 'repack-panel');
    panel.id = 'repack-panel';
    const titleRow = el('div', 'repack-panel-head');
    const title = el('div', 'repack-panel-title', 'Recarga CBR / externos');
    const btnMin = el('button', 'btn repack-min', 'Ocultar');
    btnMin.type = 'button';
    btnMin.onclick = () => {
      panel.classList.add('minimized');
      panel.hidden = true;
      const chip = ensureRestoreChip();
      chip.hidden = false;
      chip.textContent = running ? 'Recarga…' : 'Recarga CBR';
    };
    titleRow.append(title, btnMin);
    const log = el('div', 'repack-panel-log');
    log.id = 'repack-log';
    const bar = el('div', 'repack-panel-bar');
    const fill = el('div', 'repack-panel-fill');
    fill.id = 'repack-fill';
    bar.append(fill);
    const actions = el('div', 'repack-panel-actions');
    const btnStop = el('button', 'btn', 'Detener');
    btnStop.id = 'repack-stop';
    btnStop.type = 'button';
    btnStop.onclick = () => {
      if (!running) return;
      abort = true;
      btnStop.disabled = true;
      btnStop.textContent = 'Deteniendo…';
      logLine('Parada solicitada; se detendrá al terminar el paso actual…');
    };
    actions.append(btnStop);
    panel.append(titleRow, bar, log, actions);
    document.body.append(panel);
    return panel;
  }

  function resetStopButton() {
    const btnStop = document.getElementById('repack-stop');
    if (btnStop) {
      btnStop.disabled = false;
      btnStop.textContent = 'Detener';
    }
    const chip = document.getElementById('repack-chip');
    if (chip && !running) chip.textContent = 'Recarga CBR';
  }

  function logLine(text) {
    const log = document.getElementById('repack-log');
    if (!log) return;
    const line = el('div', 'repack-log-line', text);
    log.append(line);
    log.scrollTop = log.scrollHeight;
    // Persistir últimas líneas por si el SO mata la pestaña
    try {
      const prev = JSON.parse(sessionStorage.getItem('repack:log') || '[]');
      prev.push({ t: Date.now(), text });
      sessionStorage.setItem('repack:log', JSON.stringify(prev.slice(-40)));
    } catch (_) {}
  }

  function setFill(pct) {
    const fill = document.getElementById('repack-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  async function processOne(item, deleteOriginal) {
    const { ch, f } = item;
    const label = f.name || ('#' + f.id);
    const status = (t) => logLine(`[${label}] ${t}`);
    status(`Inicio (${formatBytes?.(f.size) || f.size + ' B'})`);
    if (f.size > 40 * 1024 * 1024) {
      status('AVISO: archivo grande; en móvil puede fallar por memoria');
    }
    let cbz = null;
    try {
      cbz = await convertToCbzBlob(ch, f, status);
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const outName = toCbzName(f.name);
      await uploadCbz(ch, outName, cbz, f.caption || '', status);
      cbz = null;
      status('Subido a Telegram');
      if (deleteOriginal) {
        status('Borrando original…');
        await deleteMessage(ch, f.id);
        status('Original borrado');
      }
      try { await fetchFiles(ch); } catch (_) {}
    } finally {
      cbz = null;
    }
  }

  async function runQueue(selected, deleteOriginal) {
    if (running) {
      alert('Ya hay una recarga en curso');
      return;
    }
    running = true;
    abort = false;
    try { sessionStorage.setItem('repack:log', '[]'); } catch (_) {}
    showProgressPanel();
    document.getElementById('repack-panel')?.classList.remove('minimized');
    const log = document.getElementById('repack-log');
    if (log) log.replaceChildren();
    const total = selected.length;
    let done = 0, ok = 0, fail = 0;
    logLine(`Cola: ${total} archivo(s). No cambies de app si puedes; el sistema puede cerrar la pestaña si se queda sin RAM.`);
    for (const item of selected) {
      if (abort) {
        logLine('Detenido por el usuario');
        break;
      }
      try {
        await processOne(item, deleteOriginal);
        ok++;
      } catch (e) {
        if (e?.cancelled) {
          logLine('Cancelado');
          break;
        }
        fail++;
        logLine(`ERROR ${item.f.name}: ${e?.message || e}`);
        console.error('[repack]', e);
      }
      done++;
      setFill((done / total) * 100);
      await yieldTick();
      await new Promise((r) => setTimeout(r, 300));
    }
    logLine(`Fin. OK: ${ok} · Fallos: ${fail}`);
    running = false;
    abort = false;
    resetStopButton();
  }

  function showRepackFrame() {
    document.querySelector('.info-frame.repack-frame')?.remove();
    const frame = el('div', 'info-frame repack-frame');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Recargar CBR / externos'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      'Convierte CBR → CBZ y re-sube al mismo canal. En el móvil hazlos de uno en uno y con archivos no demasiado grandes: el navegador puede matar la pestaña si se queda sin memoria (parece un “reload”).'
    ));
    // Mostrar log previo si la pestaña murió a mitad
    try {
      const prev = JSON.parse(sessionStorage.getItem('repack:log') || '[]');
      if (prev.length) {
        body.append(el('div', 'info-sec', 'Última ejecución (recuperada)'));
        const boxLog = el('div', 'repack-list');
        for (const row of prev.slice(-12)) {
          boxLog.append(el('div', 'repack-log-line', row.text));
        }
        body.append(boxLog);
      }
    } catch (_) {}

    const status = el('p', 'sync-status', 'Buscando candidatos…');
    body.append(status);
    const delLabel = el('label', 'repack-check');
    const delCb = el('input');
    delCb.type = 'checkbox';
    delCb.checked = false; // más seguro por defecto
    delLabel.append(delCb, document.createTextNode(' Borrar mensaje original tras subir'));
    body.append(delLabel);
    const listHost = el('div', 'repack-list');
    body.append(listHost);
    const actions = el('div', 'edit-actions');
    const btnAll = el('button', 'btn', 'Seleccionar todos');
    const btnNone = el('button', 'btn', 'Ninguno');
    const btnStart = el('button', 'btn edit-save', 'Iniciar');
    btnStart.disabled = true;
    actions.append(btnAll, btnNone, btnStart);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
    document.body.append(frame);

    let candidates = [];
    const checks = [];
    const paintList = () => {
      listHost.replaceChildren();
      checks.length = 0;
      if (!candidates.length) {
        listHost.append(el('p', 'cover-pick-hint', 'No hay CBR ni reenviados indexados. Entra antes en los canales.'));
        return;
      }
      for (const item of candidates) {
        const row = el('label', 'repack-row');
        const cb = el('input');
        cb.type = 'checkbox';
        // Por defecto solo el primero para no matar el móvil
        cb.checked = checks.length === 0;
        cb._item = item;
        checks.push(cb);
        const meta = el('span', 'repack-row-meta');
        meta.append(
          el('b', '', item.f.name),
          el('small', '', `${item.ch.name} · ${item.reasons.join(', ')} · ${formatBytes?.(item.f.size) || ''}`)
        );
        row.append(cb, meta);
        listHost.append(row);
      }
      btnStart.disabled = false;
    };
    btnAll.onclick = () => checks.forEach((c) => { c.checked = true; });
    btnNone.onclick = () => checks.forEach((c) => { c.checked = false; });
    btnStart.onclick = () => {
      const selected = checks.filter((c) => c.checked).map((c) => c._item);
      if (!selected.length) {
        alert('Selecciona al menos un archivo');
        return;
      }
      if (selected.length > 1 && !confirm(`Vas a procesar ${selected.length} archivos seguidos en el móvil. ¿Seguro? Mejor de uno en uno.`)) return;
      frame.remove();
      runQueue(selected, delCb.checked);
    };
    collectCandidates().then((list) => {
      candidates = list;
      status.textContent = list.length ? `${list.length} candidato(s)` : 'Sin candidatos';
      paintList();
    }).catch((e) => {
      status.textContent = 'Error: ' + (e?.message || e);
      status.classList.add('sync-err');
    });
  }

  return { showRepackFrame, isRunning: () => running };
}
