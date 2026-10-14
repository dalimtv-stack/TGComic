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
    parseComicName, comicDisplay, comicDisplayName, stripExt,
  } = d;
  const getClient = () => d.client;
  const getReady = () => d.ready;
  const getLIB = () => d.LIB;

  let running = false;
  let abort = false;

  const isCbrName = (name) => /\.cbr$/i.test(name || '');
  const toCbzName = (name) => String(name || 'comic.cbr').replace(/\.cbr$/i, '.cbz');
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  /** Limpia nombre de archivo: _ → espacios, sin dobles espacios */
  function cleanFileBase(name) {
    return String(name || '')
      .replace(/\.cb[zr]$/i, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Sugiere nombre CBZ legible:
   * [Canal] - [Serie] #[n] - [Info].cbz cuando el parseo lo permite.
   * Si no, limpia el nombre original (_ → espacio).
   */
  function suggestUploadName(ch, f) {
    const raw = f?.name || 'comic.cbr';
    const cleaned = cleanFileBase(raw);
    const chName = (ch?.name || '').trim();

    // Título personalizado en local (si existe)
    let preferred = null;
    try {
      if (typeof comicDisplayName === 'function') {
        preferred = comicDisplayName(ch, f, null);
      }
    } catch (_) {}

    let parsed = null;
    try {
      if (typeof parseComicName === 'function') {
        parsed = parseComicName(cleaned + '.cbz', chName)
          || parseComicName(raw, chName);
      }
    } catch (_) {}

    if (parsed?.series && parsed?.number != null) {
      const series = parsed.series;
      const num = String(parsed.number);
      const info = (parsed.info || '').trim();
      // Preferir formato sin repetir canal si el canal ya contextualiza
      let body;
      if (info) body = `${series} #${num} - ${info}`;
      else body = `${series} #${num}`;
      // Si el nombre original traía el canal como prefijo, mantener convención completa
      const hadChannelPrefix = chName && new RegExp('^' + chName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-', 'i').test(cleaned);
      const base = hadChannelPrefix ? `${chName} - ${body}` : body;
      return base + '.cbz';
    }

    if (preferred && String(preferred).trim()) {
      return cleanFileBase(preferred) + '.cbz';
    }

    try {
      if (typeof comicDisplay === 'function') {
        const d = comicDisplay(cleaned + '.cbz', chName) || comicDisplay(raw, chName);
        if (d && d.trim()) return cleanFileBase(d) + '.cbz';
      }
    } catch (_) {}

    return cleaned + '.cbz';
  }

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

    // GramJS en navegador: CustomFile(name, size, path='', buffer)
    // path debe ser '' (si pones el nombre lo trata como ruta de disco).
    let CustomFile;
    try {
      ({ CustomFile } = await import('telegram/client/uploads'));
    } catch (_) {
      try { ({ CustomFile } = await import('telegram/Utils')); }
      catch (_) {
        try { ({ CustomFile } = await import('telegram/Utils.js')); }
        catch (_) { CustomFile = null; }
      }
    }
    if (!CustomFile) throw new Error('CustomFile no disponible en esta build de GramJS');

    status?.('Leyendo CBZ en memoria…');
    const ab = await blob.arrayBuffer();
    const u8 = new Uint8Array(ab);
    // Preferir Buffer si el polyfill de Vite está activo (GramJS lo espera a menudo)
    const B = globalThis.Buffer;
    const buffer = B ? B.from(u8) : u8;

    const custom = new CustomFile(fileName, buffer.length || u8.byteLength, '', buffer);

    const onProg = (p) => {
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const n = Number(p);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        status?.(`Subiendo… ${Math.min(100, Math.round(n * 100))}%`);
      }
    };

    // 1) uploadFile → sendFile (más fiable en browser)
    try {
      status?.('Subiendo…');
      const inputFile = await client.uploadFile({
        file: custom,
        workers: 1,
        onProgress: onProg,
      });
      await client.sendFile(peer, {
        file: inputFile,
        caption: caption || '',
        forceDocument: true,
        attributes: attrs,
      });
      return;
    } catch (e) {
      if (e?.cancelled || abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      console.warn('[repack] uploadFile falló, sendFile(CustomFile)', e);
      status?.(`Reintento sendFile… (${e?.message || e})`);
    }

    // 2) sendFile directo con CustomFile
    try {
      await client.sendFile(peer, {
        file: custom,
        caption: caption || '',
        forceDocument: true,
        workers: 1,
        attributes: attrs,
        progressCallback: onProg,
      });
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
      const outName = item.outName || toCbzName(cleanFileBase(f.name) + '.cbr');
      status(`Nombre de subida: ${outName}`);
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


  function showNameReview(selected, deleteOriginal) {
    document.querySelector('.info-frame.repack-names')?.remove();
    const frame = el('div', 'info-frame repack-names');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Nombres al subir'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      'Revisa o edita el nombre final (.cbz). Se proponen espacios en lugar de _ y el formato Serie #n cuando se puede detectar.'
    ));

    const inputs = [];
    for (const item of selected) {
      const suggested = suggestUploadName(item.ch, item.f);
      const row = el('div', 'repack-name-row');
      row.append(el('div', 'repack-name-from', item.f.name || ''));
      const inp = el('input', 'edit-input repack-name-input');
      inp.type = 'text';
      inp.value = suggested;
      inp.autocomplete = 'off';
      inp._item = item;
      inputs.push(inp);
      row.append(inp);
      row.append(el('small', '', item.ch.name || ''));
      body.append(row);
    }

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => frame.remove();
    const goBtn = el('button', 'btn edit-save', 'Subir');
    goBtn.onclick = () => {
      const ready = inputs.map((inp) => {
        let name = String(inp.value || '').trim();
        if (!name) name = suggestUploadName(inp._item.ch, inp._item.f);
        if (!/\.cbz$/i.test(name)) name = name.replace(/\\.cb[zr]$/i, '') + '.cbz';
        // Normalizar espacios
        name = name.replace(/_/g, ' ').replace(/\\s+/g, ' ').trim();
        if (!/\.cbz$/i.test(name)) name += '.cbz';
        return { ...inp._item, outName: name };
      });
      frame.remove();
      runQueue(ready, deleteOriginal);
    };
    actions.append(cancel, goBtn);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    frame.addEventListener('click', (ev) => { if (ev.target === frame) frame.remove(); });
    document.body.append(frame);
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
      showNameReview(selected, delCb.checked);
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
