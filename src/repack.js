/**
 * Herramienta: convertir CBR → CBZ y re-subir (también mensajes reenviados).
 * Móvil: poca RAM, un archivo a la vez, liberar buffers.
 */
import * as zip from '@zip.js/zip.js';

export function createRepackTool(d) {
  const {
    el, Api,
    kv, peerOf,
    fetchFiles, getMsg,
    downloadRarBytes, sniff, TgReader,
    natural, formatBytes,
    getIsHome,
    parseComicName, comicDisplay, comicDisplayName,
  } = d;
  const getClient = () => d.client;
  const getReady = () => d.ready;
  const getLIB = () => d.LIB;

  let running = false;
  let abort = false;

  const isCbrName = (name) => /\.cbr$/i.test(name || '');
  const toCbzName = (name) => String(name || 'comic.cbr').replace(/\.cbr$/i, '.cbz');
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  async function blobToWebp(blob, quality = 0.62) {
    if (!blob || !blob.size) return blob;
    if ((blob.type || '').includes('webp') && blob.size < 1.5 * 1024 * 1024) return blob;
    let bmp = null;
    try {
      bmp = await createImageBitmap(blob);
      // Limitar lado mayor para no tumbar el móvil (OOM → recarga de la app)
      const maxEdge = 2400;
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d', { alpha: false });
      ctx.drawImage(bmp, 0, 0, w, h);
      try { bmp.close?.(); } catch (_) {}
      bmp = null;
      const out = await new Promise((res) => {
        try { cv.toBlob((b) => res(b), 'image/webp', quality); }
        catch { res(null); }
      });
      // Liberar canvas
      cv.width = 0;
      cv.height = 0;
      await yieldTick();
      return out && out.size ? out : blob;
    } catch {
      try { bmp?.close?.(); } catch (_) {}
      return blob;
    }
  }

  function cleanFileBase(name) {
    return String(name || '')
      .replace(/\.cb[zr]$/i, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /**
   * Nombre CBZ sugerido al subir.
   * Prioridad: título mostrado en la webapp (comicDisplayName + fallback de listado)
   * → parseo de nombre → limpio del archivo.
   */
  function suggestUploadName(ch, f) {
    const raw = f?.name || 'comic.cbr';
    const cleaned = cleanFileBase(raw);
    const chName = (ch?.name || '').trim();

    // Mismo criterio que las tarjetas / info del cómic
    let listFallback = cleaned;
    try {
      if (typeof comicDisplay === 'function') {
        const d = comicDisplay(raw, chName);
        if (d && String(d).trim()) listFallback = String(d).trim();
      }
    } catch (_) {}

    try {
      if (typeof comicDisplayName === 'function') {
        const shown = comicDisplayName(ch, f, listFallback);
        if (shown && String(shown).trim()) {
          return cleanFileBase(shown) + '.cbz';
        }
      }
    } catch (_) {}

    // Si no hay título de UI, intentar parseo estructurado
    let parsed = null;
    try {
      if (typeof parseComicName === 'function') {
        parsed = parseComicName(cleaned + '.cbz', chName) || parseComicName(raw, chName);
      }
    } catch (_) {}

    if (parsed?.series && parsed?.number != null) {
      const series = parsed.series;
      const num = String(parsed.number);
      const info = (parsed.info || '').trim();
      let body = info ? `${series} #${num} - ${info}` : `${series} #${num}`;
      const hadChannelPrefix = chName && new RegExp(
        '^' + chName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-',
        'i'
      ).test(cleaned);
      return (hadChannelPrefix ? `${chName} - ${body}` : body) + '.cbz';
    }

    return cleaned + '.cbz';
  }

  async function downloadWholeMessage(msg, size, status) {
    const client = getClient();
    const ac = { get cancelled() { return abort; } };
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
  async function convertToCbzBlob(ch, f, status, opts) {
    const wantWebp = !!(opts && opts.asWebp);
    const msg = await getMsg(ch, f);
    if (!msg?.media) throw new Error('Sin media en el mensaje');

    const probe = new TgReader(msg, f.size);
    const kind = await sniff(probe);

    const mimeOf = (name) => {
      const e = (String(name).split(/[/\\]/).pop() || name).toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
      if (!e) return 'application/octet-stream';
      return ({
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
      })[e[1]] || 'application/octet-stream';
    };

    async function imagesToCbzFromRarData(data) {
      const { createExtractorFromData } = await import('node-unrar-js');
      const rarWasm = (await import('node-unrar-js/esm/js/unrar.wasm?url')).default;
      const ab = data.buffer.byteLength === data.byteLength && data.byteOffset === 0
        ? data.buffer
        : data.slice().buffer;
      const ex = await createExtractorFromData({
        wasmBinary: await (await fetch(rarWasm)).arrayBuffer(),
        data: ab,
      });
      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
        bufferedWrite: true,
        level: 0,
      });
      let nImg = 0;
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
        const copy = new Uint8Array(src.byteLength);
        copy.set(src);
        let pageBlob = new Blob([copy.buffer], { type: mimeOf(base) });
        let outName = base;
        if (wantWebp) {
          const origSize = pageBlob.size || 0;
          const converted = await blobToWebp(pageBlob);
          if (converted && converted.size && converted.size < origSize * 0.98) {
            pageBlob = converted;
            outName = base.replace(/\.[^.]+$/i, '.webp');
          }
        }
        nImg++;
        await writer.add(outName, new zip.BlobReader(pageBlob), { level: 0 });
        pageBlob = null;
        status(`Empaquetando… ${nImg} img` + (wantWebp ? ' (WebP)' : ''));
        await yieldTick();
        if (nImg % 3 === 0) await new Promise((r) => setTimeout(r, 30));
      }
      if (!nImg) {
        try { await writer.close(); } catch (_) {}
        throw new Error('CBR sin imágenes legibles');
      }
      const out = await writer.close();
      status(`CBZ listo (${formatBytes?.(out.size) || out.size + ' B'}, ${nImg} img)`);
      return out;
    }

    async function imagesToCbzFromZipBlob(blob) {
      const reader = new zip.ZipReader(new zip.BlobReader(blob));
      const entries = await reader.getEntries();
      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
        bufferedWrite: true,
        level: 0,
      });
      let nImg = 0;
      for (const e of entries) {
        if (abort) {
          try { await writer.close(); } catch (_) {}
          try { await reader.close(); } catch (_) {}
          throw Object.assign(new Error('cancelado'), { cancelled: true });
        }
        if (e.directory) continue;
        const base = (e.filename || '').split(/[/\\]/).pop() || e.filename;
        if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
        let pageBlob = await e.getData(new zip.BlobWriter());
        let outName = base;
        if (wantWebp) {
          const origSize = pageBlob.size || 0;
          const converted = await blobToWebp(pageBlob);
          if (converted && converted.size && converted.size < origSize * 0.98) {
            pageBlob = converted;
            outName = base.replace(/\.[^.]+$/i, '.webp');
          }
        }
        nImg++;
        await writer.add(outName, new zip.BlobReader(pageBlob), { level: 0 });
        pageBlob = null;
        status(`Empaquetando… ${nImg} img` + (wantWebp ? ' (WebP)' : ''));
        await yieldTick();
        if (nImg % 3 === 0) await new Promise((r) => setTimeout(r, 30));
      }
      await reader.close();
      if (!nImg) {
        try { await writer.close(); } catch (_) {}
        throw new Error('ZIP sin imágenes legibles');
      }
      const out = await writer.close();
      status(`CBZ listo (${formatBytes?.(out.size) || out.size + ' B'}, ${nImg} img)`);
      return out;
    }

    if (kind === 'zip') {
      status('Es ZIP (CBR falso): descarga…');
      const data = await downloadWholeMessage(msg, f.size, status);
      const blob = new Blob([data], { type: 'application/zip' });
      if (!wantWebp) {
        status(`Listo para subir (${formatBytes?.(blob.size) || blob.size + ' B'})`);
        return blob;
      }
      status('Reempaquetando ZIP → WebP…');
      return imagesToCbzFromZipBlob(blob);
    }

    status('Descargando CBR (RAR)…');
    let data = await downloadWholeMessage(msg, f.size, status);
    if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
    status('Extrayendo RAR → CBZ…');
    const out = await imagesToCbzFromRarData(data);
    data = null;
    return out;
  }

  /**
   * Subida en navegador con GramJS:
   * - uploadFile acepta File del navegador
   * - sendFile recibe el InputFile resultante
   * - Fallback: CustomFile con buffer explícito (path '')
   */
  async function uploadCbz(ch, fileName, blob, caption, status) {
    await getReady();
    const peer = peerOf(ch);
    const client = getClient();
    if (!blob || !blob.size) throw new Error('CBZ vacío');
    status?.(`Preparando subida… (${formatBytes?.(blob.size) || blob.size + ' B'})`);

    const attrs = [new Api.DocumentAttributeFilename({ fileName })];
    const onProg = (p) => {
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const n = Number(p);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        status?.(`Subiendo… ${Math.min(100, Math.round(n * 100))}%`);
      }
    };

    // --- 1) Browser File → uploadFile → sendFile ---
    try {
      const browserFile = new File([blob], fileName, {
        type: blob.type || 'application/zip',
      });
      status?.('Subiendo…');
      const inputFile = await client.uploadFile({
        file: browserFile,
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
      console.warn('[repack] uploadFile(File) falló', e);
      status?.(`Reintento (CustomFile)… (${e?.message || e})`);
    }

    // --- 2) CustomFile + buffer explícito ---
    status?.('Leyendo CBZ en memoria…');
    const ab = await blob.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const B = globalThis.Buffer;
    const buffer = B ? B.from(u8) : u8;

    let CustomFile = null;
    for (const mod of ['telegram/client/uploads', 'telegram/Utils', 'telegram/Utils.js']) {
      try {
        const m = await import(/* @vite-ignore */ mod);
        if (m.CustomFile) { CustomFile = m.CustomFile; break; }
      } catch (_) {}
    }
    if (!CustomFile) throw new Error('CustomFile no disponible en GramJS');

    const custom = new CustomFile(fileName, u8.byteLength, '');
    // Algunas builds no asignan el 4º arg: forzar buffer
    try { custom.buffer = buffer; } catch (_) {}
    try {
      if (custom.buffer == null) Object.defineProperty(custom, 'buffer', { value: buffer, writable: true });
    } catch (_) {}

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
      console.warn('[repack] uploadFile(CustomFile) falló', e);
      status?.(`Reintento sendFile… (${e?.message || e})`);
    }

    // --- 3) sendFile(CustomFile) ---
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
        delete panel.dataset.userHidden;
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
      // No mostrar encima del lector u otras vistas
      const allow = typeof getIsHome === 'function' ? !!getIsHome() : !document.getElementById('rd');
      panel.hidden = !allow;
      delete panel.dataset.userHidden;
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
      panel.hidden = true;
      panel.dataset.userHidden = '1';
      panel.classList.remove('minimized');
      const chip = ensureRestoreChip();
      // Solo mostrar chip en home
      const home = typeof getIsHome === 'function' ? !!getIsHome() : true;
      chip.hidden = !home || !!document.getElementById('rd');
    };
    titleRow.append(title, btnMin);
    const bar = el('div', 'repack-panel-bar');
    const fill = el('div', 'repack-panel-fill');
    fill.id = 'repack-fill';
    bar.append(fill);
    const log = el('div', 'repack-panel-log');
    log.id = 'repack-log';
    const actions = el('div', 'repack-panel-actions');
    const btnStop = el('button', 'btn', 'Detener');
    btnStop.id = 'repack-stop';
    btnStop.type = 'button';
    btnStop.onclick = () => {
      abort = true;
      btnStop.disabled = true;
      btnStop.textContent = 'Deteniendo…';
      logLine('Cancelando…');
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

  async function processOne(item, deleteOriginal, asWebp = false) {
    const { ch, f } = item;
    const label = f.name || ('#' + f.id);
    const status = (t) => logLine(`[${label}] ${t}`);
    status(`Inicio (${formatBytes?.(f.size) || f.size + ' B'})`);
    if (f.size > 40 * 1024 * 1024) {
      status('AVISO: archivo grande; en móvil puede fallar por memoria');
    }
    let cbz = null;
    try {
      const useWebp = !!(item && item.asWebp) || !!asWebp;
      cbz = await convertToCbzBlob(ch, f, status, { asWebp: useWebp });
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      let outName = item.outName || toCbzName(cleanFileBase(f.name) + '.cbr');
      outName = String(outName).trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
      if (!/\.cbz$/i.test(outName)) outName = outName.replace(/\.cb[zr]$/i, '') + '.cbz';
      if (useWebp && !/\[WebP\]/i.test(outName)) {
        outName = outName.replace(/\.cbz$/i, ' [WebP].cbz');
      }
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

  async function runQueue(selected, deleteOriginal, asWebp = false) {
    if (running) {
      alert('Ya hay una recarga en curso');
      return;
    }
    running = true;
    abort = false;
    try { sessionStorage.setItem('repack:log', '[]'); } catch (_) {}
    const total = selected.length;
    let done = 0, ok = 0, fail = 0;

    const work = async (item, ctx) => {
      await processOne({ ...item, asWebp }, deleteOriginal, asWebp);
    };

    if (jobQueue && typeof jobQueue.enqueue === 'function' && selected.length) {
      for (const item of selected) {
        jobQueue.enqueue({
          type: 'repack',
          label: item.outName || item.f?.name || 'repack',
          run: async (ctx) => {
            await work(item, ctx);
            ctx.setProgress(100);
          },
        });
      }
      try { jobQueue.show(); } catch (_) {}
      running = false;
      resetStopButton();
      return;
    }

    showProgressPanel();
    document.getElementById('repack-panel')?.classList.remove('minimized');
    const log = document.getElementById('repack-log');
    if (log) log.replaceChildren();
    logLine(`Cola: ${total} archivo(s).` + (asWebp ? ' WebP ON' : ''));

    for (const item of selected) {
      if (abort) {
        logLine('Detenido por el usuario');
        break;
      }
      try {
        await processOne({ ...item, asWebp }, deleteOriginal, asWebp);
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

  /** Pantalla para renombrar cada archivo antes de subir */
  function showNameReview(selected, deleteOriginal, asWebp = false) {
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
      'Edita el nombre final de cada archivo (.cbz). Se proponen espacios en lugar de _ cuando se puede.'
    ));
    if (asWebp) {
      body.append(el('p', 'cover-pick-hint', 'WebP activado: se añadirá [WebP] al nombre y las páginas se convertirán.'));
    }

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
        name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/\.cbz$/i.test(name)) name = name.replace(/\.cb[zr]$/i, '') + '.cbz';
        if (!/\.cbz$/i.test(name)) name += '.cbz';
        return { ...inp._item, outName: name };
      });
      frame.remove();
      runQueue(ready, deleteOriginal, asWebp);
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
      'Convierte CBR → CBZ y re-sube al mismo canal. Podrás editar el nombre antes de subir. En el móvil hazlos de uno en uno.'
    ));
    const status = el('div', 'sync-status', 'Buscando candidatos…');
    body.append(status);

    const delLabel = el('label', 'repack-del');
    const delCb = el('input');
    delCb.type = 'checkbox';
    delCb.checked = true;
    delLabel.append(delCb, document.createTextNode(' Borrar el original tras subir OK'));
    body.append(delLabel);

    const webpLabel = el('label', 'repack-check');
    const webpCb = el('input');
    webpCb.type = 'checkbox';
    webpLabel.append(webpCb, document.createTextNode(' Convertir páginas a WebP (añade [WebP] al nombre)'));
    body.append(webpLabel);

    const listHost = el('div', 'repack-list');
    body.append(listHost);
    const actions = el('div', 'edit-actions');
    const btnAll = el('button', 'btn', 'Seleccionar todos');
    const btnNone = el('button', 'btn', 'Ninguno');
    const btnStart = el('button', 'btn edit-save', 'Siguiente');
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
      if (selected.length > 1 && !confirm(`Vas a procesar ${selected.length} archivos. ¿Seguro? Mejor de uno en uno en móvil.`)) return;
      frame.remove();
      // Siempre pedir/editar nombres antes de subir
      showNameReview(selected, delCb.checked, !!webpCb.checked);
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

  function hideFloatingUi() {
    const panel = document.getElementById('repack-panel');
    const chip = document.getElementById('repack-chip');
    if (panel) panel.hidden = true;
    if (chip) chip.hidden = true;
  }

  /** Solo visible en home y fuera del lector. Si hay trabajo en curso, chip en home. */
  function syncFloatingUi() {
    const home = typeof getIsHome === 'function' ? !!getIsHome() : (stackSafeHome());
    const reading = !!document.getElementById('rd');
    if (reading || !home) {
      hideFloatingUi();
      return;
    }
    // En home: si hay panel y está corriendo, mostrar chip si el panel estaba oculto a propósito
    const panel = document.getElementById('repack-panel');
    const chip = document.getElementById('repack-chip');
    if (running) {
      if (panel && !panel.dataset.userHidden) {
        panel.hidden = false;
        if (chip) chip.hidden = true;
      } else if (chip) {
        chip.hidden = false;
      } else if (panel) {
        // panel existe pero userHidden
        if (chip) chip.hidden = false;
      }
    } else {
      // Sin trabajo: no mostrar restos
      hideFloatingUi();
    }
  }

  function stackSafeHome() {
    try {
      return !document.getElementById('rd');
    } catch {
      return true;
    }
  }

  // Al abrir/cerrar el lector
  try {
    window.addEventListener('tgcomic:reader', (ev) => {
      if (ev?.detail?.open) hideFloatingUi();
      else syncFloatingUi();
    });
  } catch (_) {}

  return {
    showRepackFrame,
    isRunning: () => running,
    hideFloatingUi,
    syncFloatingUi,
  };
}

