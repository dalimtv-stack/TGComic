/**
 * Herramienta: convertir CBR → CBZ y re-subir (también mensajes reenviados)
 * en el mismo canal, en segundo plano, liberando temporales.
 */
import * as zip from '@zip.js/zip.js';

/**
 * @param {object} d dependencias desde main
 */
export function createRepackTool(d) {
  const {
    el, Api, bigInt,
    kv, peerOf,
    fetchFiles, getMsg, openPages, pageBlob,
    downloadRarBytes, sniff, TgReader, pagesOf,
    natural, formatBytes,
  } = d;
  const getClient = () => d.client;
  const getReady = () => d.ready;
  const getLIB = () => d.LIB;

  let running = false;
  let abort = false;

  function isCbrName(name) {
    return /\.cbr$/i.test(name || '');
  }
  function toCbzName(name) {
    return String(name || 'comic.cbr').replace(/\.cbr$/i, '.cbz');
  }

  async function buildCbzFromPages(pages, onProgress) {
    const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { bufferedWrite: true });
    const total = pages.length || 1;
    for (let i = 0; i < pages.length; i++) {
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const p = pages[i];
      const name = (p.filename || p.name || `page_${String(i + 1).padStart(4, '0')}.jpg`).replace(/^\/+/, '');
      const blob = p.blob || (await pageBlob(p));
      await writer.add(name, new zip.BlobReader(blob), { level: 0 }); // store: más rápido, CBZ típico
      onProgress?.(`Empaquetando CBZ… ${i + 1}/${total}`);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    const out = await writer.close();
    return out;
  }

  async function downloadAsBlob(ch, f, status) {
    const ac = { get cancelled() { return abort; } };
    const msg = await getMsg(ch, f);
    if (!msg?.media) throw new Error('Sin media en el mensaje');
    const r = new TgReader(msg, f.size);
    const kind = await sniff(r);
    if (kind === 'zip') {
      // Ya es ZIP (aunque se llame .cbr): leer páginas o re-subir bytes
      status('Leyendo archivo ZIP…');
      const zr = new zip.ZipReader(r);
      try {
        const entries = pagesOf(await zr.getEntries());
        if (!entries.length) throw new Error('ZIP sin imágenes');
        // Si solo queremos reempaquetar limpio:
        const pages = [];
        for (let i = 0; i < entries.length; i++) {
          if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
          const e = entries[i];
          const blob = await pageBlob(e);
          pages.push({ filename: e.filename, blob });
          if (i % 3 === 2) status(`Extrayendo… ${i + 1}/${entries.length}`);
        }
        return { pages, caption: f.caption || '' };
      } finally {
        try { await zr.close(); } catch (_) {}
      }
    }
    // RAR real
    status(`Descargando CBR… 0%`);
    const data = await downloadRarBytes(msg, f.size, status, ac);
    if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
    status('Extrayendo RAR…');
    const { createExtractorFromData } = await import('node-unrar-js');
    const rarWasm = (await import('node-unrar-js/esm/js/unrar.wasm?url')).default;
    const ab = data.buffer.byteLength === data.byteLength && data.byteOffset === 0
      ? data.buffer
      : data.slice().buffer;
    const ex = await createExtractorFromData({
      wasmBinary: await (await fetch(rarWasm)).arrayBuffer(),
      data: ab,
    });
    const mimeOf = (name) => {
      const e = (name.split(/[/\\]/).pop() || name).toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
      if (!e) return 'application/octet-stream';
      return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' })[e[1]] || 'application/octet-stream';
    };
    const pages = [];
    for (const x of ex.extract().files) {
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const n = x.fileHeader.name || '';
      if (x.fileHeader.flags.directory || !x.extraction) continue;
      const base = n.split(/[/\\]/).pop() || n;
      if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
      const raw = x.extraction;
      const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (!src.byteLength) continue;
      const copy = new ArrayBuffer(src.byteLength);
      new Uint8Array(copy).set(src);
      pages.push({ filename: base, blob: new Blob([copy], { type: mimeOf(base) }) });
    }
    pages.sort((a, b) => natural(a.filename, b.filename));
    if (!pages.length) throw new Error('CBR sin imágenes');
    return { pages, caption: f.caption || '' };
  }

  async function uploadCbz(ch, fileName, blob, caption) {
    await getReady();
    const peer = peerOf(ch);
    const client = getClient();
    const buf = new Uint8Array(await blob.arrayBuffer());
    const attrs = [new Api.DocumentAttributeFilename({ fileName })];
    const baseOpts = {
      caption: caption || '',
      forceDocument: true,
      workers: 1,
      attributes: attrs,
    };

    // 1) CustomFile (API correcta de gramJS en browser)
    const tryCustom = async () => {
      let CustomFile;
      try {
        ({ CustomFile } = await import('telegram/Utils'));
      } catch (_) {
        try { ({ CustomFile } = await import('telegram/Utils.js')); } catch (__) {}
      }
      if (!CustomFile) throw new Error('CustomFile no disponible');
      const fileArg = new CustomFile(fileName, buf.byteLength, fileName, buf);
      return client.sendFile(peer, { ...baseOpts, file: fileArg });
    };

    // 2) Buffer polyfill
    const tryBuffer = async () => {
      const B = globalThis.Buffer;
      if (!B) throw new Error('Buffer no disponible');
      return client.sendFile(peer, { ...baseOpts, file: B.from(buf) });
    };

    // 3) Uint8Array crudo
    const tryRaw = async () => client.sendFile(peer, { ...baseOpts, file: buf });

    let lastErr;
    for (const fn of [tryCustom, tryBuffer, tryRaw]) {
      try {
        await fn();
        return;
      } catch (e) {
        lastErr = e;
        console.warn('[repack] upload attempt failed', fn.name, e);
      }
    }
    throw lastErr || new Error('No se pudo subir el archivo');
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
  }

  function setFill(pct) {
    const fill = document.getElementById('repack-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  async function processOne(item, deleteOriginal) {
    const { ch, f } = item;
    const label = f.name || ('#' + f.id);
    const status = (t) => logLine(`[${label}] ${t}`);
    status('Iniciando…');
    let pages = null;
    let caption = f.caption || '';
    try {
      const got = await downloadAsBlob(ch, f, status);
      pages = got.pages;
      caption = got.caption || caption;
      status(`Imágenes: ${pages.length}`);
      const cbz = await buildCbzFromPages(pages, status);
      // Liberar páginas
      pages = null;
      const outName = toCbzName(f.name);
      status(`Subiendo ${outName} (${formatBytes?.(cbz.size) || cbz.size + ' B'})…`);
      await uploadCbz(ch, outName, cbz, caption);
      status('Subido');
      if (deleteOriginal) {
        status('Borrando original…');
        await deleteMessage(ch, f.id);
        status('Original borrado');
      }
      // refrescar listado canal
      try { await fetchFiles(ch); } catch (_) {}
    } finally {
      pages = null;
    }
  }

  async function runQueue(selected, deleteOriginal) {
    if (running) {
      alert('Ya hay una recarga en curso');
      return;
    }
    running = true;
    abort = false;
    showProgressPanel();
    document.getElementById('repack-panel')?.classList.remove('minimized');
    const log = document.getElementById('repack-log');
    if (log) log.replaceChildren();
    const total = selected.length;
    let done = 0;
    let ok = 0;
    let fail = 0;
    logLine(`Cola: ${total} archivo(s)`);
    for (const item of selected) {
      if (abort) {
        logLine('Detenido por el usuario');
        break;
      }
      try {
        await processOne(item, deleteOriginal);
        ok++;
      } catch (e) {
        fail++;
        logLine(`ERROR ${item.f.name}: ${e?.message || e}`);
        console.error('[repack]', e);
      }
      done++;
      setFill((done / total) * 100);
      // Ceder al navegador
      await new Promise((r) => setTimeout(r, 200));
    }
    logLine(`Fin. OK: ${ok} · Fallos: ${fail}`);
    running = false;
    abort = false;
    resetStopButton();
    const chip = document.getElementById('repack-chip');
    if (chip) chip.textContent = 'Recarga CBR';
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
      'Descarga CBR (y reenviados), los convierte a CBZ, los sube al mismo canal y puede borrar el mensaje original. Requiere permiso de escritura en el canal. Procesa de uno en uno; no cierres la pestaña.'
    ));
    const status = el('p', 'sync-status', 'Buscando candidatos…');
    body.append(status);

    const delLabel = el('label', 'repack-check');
    const delCb = el('input');
    delCb.type = 'checkbox';
    delCb.checked = true;
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
      if (!candidates.length) {
        listHost.append(el('p', 'cover-pick-hint', 'No hay CBR ni reenviados en la biblioteca en caché. Entra en los canales para indexar archivos.'));
        return;
      }
      for (const item of candidates) {
        const row = el('label', 'repack-row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = true;
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
      if (!confirm(`Se procesarán ${selected.length} archivo(s). ¿Continuar?`)) return;
      frame.remove();
      runQueue(selected, delCb.checked);
    };

    collectCandidates().then((list) => {
      candidates = list;
      status.textContent = list.length
        ? `${list.length} candidato(s) (CBR o reenviados)`
        : 'Sin candidatos';
      paintList();
    }).catch((e) => {
      status.textContent = 'Error: ' + (e?.message || e);
      status.classList.add('sync-err');
    });
  }

  return { showRepackFrame, isRunning: () => running };
}
