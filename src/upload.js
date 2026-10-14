/**
 * Subida de cómics nuevos a Telegram (CBZ).
 * - Convierte CBR → CBZ si hace falta
 * - Crea canal si no existe: Nombre:Editorial::Comics::tgstorage
 * - Composición de nombre: [Canal] - [Serie] #n - [Info].cbz
 */
import * as zip from '@zip.js/zip.js';
import { createExtractorFromData } from 'node-unrar-js';
import rarWasm from 'node-unrar-js/esm/js/unrar.wasm?url';

const SEP = '::';
const TSEP = ':';
const POST = SEP + 'tgstorage';
const LIBRARY_LABEL = 'Comics'; // título visible en Telegram

export function createUploadTool(d) {
  const {
    el, Api, bigInt,
    kv, peerOf,
    fetchFiles, refreshLibrary,
    natural, formatBytes,
    jobQueue,
  } = d;
  const getClient = () => d.client;
  const getReady = () => d.ready;
  const getLIB = () => d.LIB;
  const setLIB = (v) => { if (typeof d.setLIB === 'function') d.setLIB(v); };
  if (typeof el !== 'function') {
    throw new Error('createUploadTool: falta el()');
  }

  let busy = false;
  let abort = false;

  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  async function blobToWebp(blob, quality = 0.82) {
    if (!blob || !blob.size) return blob;
    if ((blob.type || '').includes('webp')) return blob;
    try {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      const out = await new Promise((res) => cv.toBlob(res, 'image/webp', quality));
      return out || blob;
    } catch {
      return blob;
    }
  }

  function ensureUploadChip() {
    let chip = document.getElementById('upload-chip');
    if (chip) return chip;
    chip = el('button', 'repack-chip', 'Subida');
    chip.id = 'upload-chip';
    chip.type = 'button';
    chip.title = 'Mostrar progreso de subida';
    chip.onclick = () => {
      const panel = document.getElementById('upload-panel');
      if (panel) {
        panel.hidden = false;
        delete panel.dataset.userHidden;
      }
      chip.hidden = true;
    };
    document.body.append(chip);
    return chip;
  }

  function showUploadProgressPanel() {
    let panel = document.getElementById('upload-panel');
    if (panel) {
      panel.hidden = false;
      delete panel.dataset.userHidden;
      const chip = document.getElementById('upload-chip');
      if (chip) chip.hidden = true;
      return panel;
    }
    panel = el('div', 'repack-panel');
    panel.id = 'upload-panel';
    const titleRow = el('div', 'repack-panel-head');
    const title = el('div', 'repack-panel-title', 'Subida de cómic');
    const btnMin = el('button', 'btn repack-min', 'Ocultar');
    btnMin.type = 'button';
    btnMin.onclick = () => {
      panel.hidden = true;
      panel.dataset.userHidden = '1';
      const chip = ensureUploadChip();
      const home = typeof d.getIsHome === 'function' ? !!d.getIsHome() : !document.getElementById('rd');
      chip.hidden = !home || !!document.getElementById('rd');
    };
    titleRow.append(title, btnMin);
    const bar = el('div', 'repack-panel-bar');
    const fill = el('div', 'repack-panel-fill');
    fill.id = 'upload-fill';
    bar.append(fill);
    const log = el('div', 'repack-panel-log');
    log.id = 'upload-log';
    const actions = el('div', 'repack-panel-actions');
    const btnStop = el('button', 'btn', 'Cerrar');
    btnStop.id = 'upload-stop';
    btnStop.type = 'button';
    btnStop.onclick = () => {
      if (busy) {
        abort = true;
        logLine('Cancelando…');
        btnStop.textContent = 'Cerrando…';
      }
      panel.hidden = true;
      const chip = document.getElementById('upload-chip');
      if (chip && busy) {
        chip.hidden = false;
        chip.textContent = 'Subida…';
      } else {
        if (chip) chip.hidden = true;
      }
    };
    actions.append(btnStop);
    panel.append(titleRow, bar, log, actions);
    document.body.append(panel);
    return panel;
  }

  function logLine(text) {
    const log = document.getElementById('upload-log');
    if (!log) return;
    const line = el('div', 'repack-log-line', text);
    log.append(line);
    log.scrollTop = log.scrollHeight;
  }

  function setFill(pct) {
    const fill = document.getElementById('upload-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function syncFloatingUi() {
    const home = typeof d.getIsHome === 'function' ? !!d.getIsHome() : !document.getElementById('rd');
    const reading = !!document.getElementById('rd');
    const panel = document.getElementById('upload-panel');
    const chip = document.getElementById('upload-chip');
    if (reading || !home) {
      if (panel) panel.hidden = true;
      if (chip) chip.hidden = true;
      return;
    }
    if (busy) {
      if (panel && !panel.dataset.userHidden) {
        panel.hidden = false;
        if (chip) chip.hidden = true;
      } else if (chip) {
        chip.hidden = false;
      }
    } else {
      if (panel) panel.hidden = true;
      if (chip) chip.hidden = true;
    }
  }

  function hideFloatingUi() {
    const panel = document.getElementById('upload-panel');
    const chip = document.getElementById('upload-chip');
    if (panel) panel.hidden = true;
    if (chip) chip.hidden = true;
  }


  function channelTitle(channelName, editorial) {
    const ch = String(channelName || '').trim();
    const ed = String(editorial || '').trim() || 'Sin editorial';
    return `${ch}${TSEP}${ed}${SEP}${LIBRARY_LABEL}${POST}`;
  }

  function composeFileName({ channel, series, number, info }) {
    const ch = String(channel || '').trim();
    const ser = String(series || '').trim();
    const num = String(number || '').trim();
    const inf = String(info || '').trim().replace(/\s*\[[^\]]*\]/g, '').trim();
    let body = '';
    if (ser && num) body = `${ser} #${num}`;
    else if (ser) body = ser;
    else if (num) body = `#${num}`;
    else body = 'comic';
    if (inf) body += ` - ${inf}`;
    // Preferir con canal si hay serie (formato completo del proyecto)
    const base = (ch && ser) ? `${ch} - ${body}` : body;
    return base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() + '.cbz';
  }

  function isRarHeader(u8) {
    return u8 && u8.length >= 4 && u8[0] === 0x52 && u8[1] === 0x61 && u8[2] === 0x72 && u8[3] === 0x21;
  }
  function isZipHeader(u8) {
    return u8 && u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b;
  }

  async function localFileToCbzBlob(file, status, opts) {
    const wantWebp = !!(opts && opts.asWebp);
    status?.('Leyendo archivo…');
    const ab = await file.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const name = file.name || 'comic';

    const mimeOf = (n) => {
      const e = (String(n).split(/[/\\]/).pop() || n).toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
      if (!e) return 'application/octet-stream';
      const ext = e[1].toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
      return 'image/' + ext;
    };

    async function packImagesFromEntries(getEntries, closeReader) {
      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
      let nImg = 0;
      const entries = await getEntries();
      for (const e of entries) {
        if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
        if (e.directory) continue;
        const base = (e.filename || '').split(/[/\\]/).pop() || e.filename;
        if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
        let pageBlob = await e.getData(new zip.BlobWriter());
        let outName = base;
        if (wantWebp) {
          pageBlob = await blobToWebp(pageBlob);
          outName = base.replace(/\.[^.]+$/i, '.webp');
        }
        nImg++;
        await writer.add(outName, new zip.BlobReader(pageBlob), { level: 0 });
        if (nImg % 5 === 0) {
          status?.(wantWebp ? `WebP… ${nImg} img` : `Empaquetando… ${nImg} img`);
          await yieldTick();
        }
      }
      if (closeReader) await closeReader();
      if (!nImg) {
        try { await writer.close(); } catch (_) {}
        throw new Error('Sin imágenes legibles');
      }
      const out = await writer.close();
      status?.(`CBZ listo (${formatBytes?.(out.size) || out.size + ' B'}, ${nImg} img)` + (wantWebp ? ' WebP' : ''));
      return out;
    }

    // ZIP / CBZ
    if (isZipHeader(u8) || /\.cbz$/i.test(name)) {
      if (!wantWebp) {
        status?.('Ya es ZIP/CBZ');
        return new Blob([u8], { type: 'application/zip' });
      }
      status?.('Reempaquetando CBZ → WebP…');
      const reader = new zip.ZipReader(new zip.BlobReader(new Blob([u8], { type: 'application/zip' })));
      return packImagesFromEntries(
        () => reader.getEntries(),
        () => reader.close(),
      );
    }

    // RAR / CBR
    if (!isRarHeader(u8) && !/\.cbr$/i.test(name)) {
      if (isZipHeader(u8)) return new Blob([u8], { type: 'application/zip' });
      throw new Error('Formato no soportado (usa CBZ o CBR)');
    }

    status?.('Extrayendo CBR…');
    const dataAb = u8.buffer.byteLength === u8.byteLength && u8.byteOffset === 0
      ? u8.buffer
      : u8.slice().buffer;
    const ex = await createExtractorFromData({
      wasmBinary: await (await fetch(rarWasm)).arrayBuffer(),
      data: dataAb,
    });
    const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
    let nImg = 0;
    for (const x of ex.extract().files) {
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
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
        pageBlob = await blobToWebp(pageBlob);
        outName = base.replace(/\.[^.]+$/i, '.webp');
      }
      nImg++;
      await writer.add(outName, new zip.BlobReader(pageBlob), { level: 0 });
      if (nImg % 5 === 0) {
        status?.(wantWebp ? `WebP… ${nImg} img` : `Empaquetando… ${nImg} img`);
        await yieldTick();
      }
    }
    if (!nImg) {
      try { await writer.close(); } catch (_) {}
      throw new Error('CBR sin imágenes legibles');
    }
    const out = await writer.close();
    status?.(`CBZ listo (${formatBytes?.(out.size) || out.size + ' B'}, ${nImg} img)` + (wantWebp ? ' WebP' : ''));
    return out;
  }

  async function uploadCbz(ch, fileName, blob, caption, status) {
    await getReady();
    const peer = peerOf(ch);
    const client = getClient();
    if (!blob || !blob.size) throw new Error('Archivo vacío');
    status?.(`Preparando subida… (${formatBytes?.(blob.size) || blob.size + ' B'})`);

    const attrs = [new Api.DocumentAttributeFilename({ fileName })];
    const onProg = (p) => {
      const n = Number(p);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        status?.(`Subiendo… ${Math.min(100, Math.round(n * 100))}%`);
      }
    };

    // 1) Browser File → uploadFile → sendFile (lo que funciona en la web)
    try {
      const browserFile = new File([blob], fileName, { type: blob.type || 'application/zip' });
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
      console.warn('[upload] uploadFile(File) falló', e);
      status?.(`Reintento… (${e?.message || e})`);
    }

    // 2) CustomFile + buffer explícito
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
    if (!CustomFile) throw new Error('CustomFile no disponible');

    const custom = new CustomFile(fileName, u8.byteLength, '');
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
      console.warn('[upload] CustomFile falló', e);
      status?.(`Reintento sendFile… (${e?.message || e})`);
    }

    await client.sendFile(peer, {
      file: custom,
      caption: caption || '',
      forceDocument: true,
      workers: 1,
      attributes: attrs,
      progressCallback: onProg,
    });
  }

  /** Crea canal broadcast con título tgstorage si no existe en LIB */
  async function ensureChannel(channelName, editorial, status) {
    await getReady();
    const client = getClient();
    const name = String(channelName || '').trim();
    const group = String(editorial || '').trim() || 'Sin editorial';
    if (!name) throw new Error('Falta el nombre del canal');

    const lib = Array.isArray(getLIB()) ? getLIB() : [];
    const found = lib.find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
        && (c.group || '').toLowerCase() === group.toLowerCase()
    );
    if (found) return found;

    // Buscar por título exacto en diálogos (por si no está en LIB aún)
    const title = channelTitle(name, group);
    status?.(`Creando canal «${title}»…`);

    let created;
    try {
      created = await client.invoke(new Api.channels.CreateChannel({
        title,
        about: 'Biblioteca de cómics (tgstorage)',
        broadcast: true,
        megagroup: false,
      }));
    } catch (e) {
      // Algunos clientes usan megagrupo
      try {
        created = await client.invoke(new Api.channels.CreateChannel({
          title,
          about: 'Biblioteca de cómics (tgstorage)',
          broadcast: false,
          megagroup: true,
        }));
      } catch (e2) {
        throw new Error('No se pudo crear el canal: ' + (e2?.message || e?.message || e2 || e));
      }
    }

    const chats = created?.chats || [];
    const chEntity = chats.find((c) => c.className === 'Channel') || chats[0];
    if (!chEntity) throw new Error('Canal creado pero sin entidad en la respuesta');

    const entry = {
      id: String(chEntity.id),
      hash: String(chEntity.accessHash),
      name,
      group,
    };

    // Archivar el canal (como tgstorage: no aparece en la lista principal de chats)
    try {
      status?.('Archivando canal…');
      const inputPeer = new Api.InputPeerChannel({
        channelId: bigInt(entry.id),
        accessHash: bigInt(entry.hash),
      });
      await client.invoke(new Api.folders.EditPeerFolders({
        folderPeers: [
          new Api.InputFolderPeer({
            peer: inputPeer,
            folderId: 1, // 1 = Archivados
          }),
        ],
      }));
    } catch (e) {
      console.warn('[upload] no se pudo archivar el canal (sigue usable)', e);
      status?.('Canal creado (sin archivar: ' + (e?.message || e) + ')');
    }

    // Refrescar biblioteca y fusionar
    try {
      if (typeof refreshLibrary === 'function') {
        const fresh = await refreshLibrary();
        if (Array.isArray(fresh) && fresh.length) {
          setLIB(fresh);
          const again = fresh.find((c) => String(c.id) === entry.id)
            || fresh.find((c) => c.name.toLowerCase() === name.toLowerCase() && (c.group || '').toLowerCase() === group.toLowerCase());
          if (again) {
            status?.('Canal listo (archivado)');
            return again;
          }
        }
      }
    } catch (e) {
      console.warn('[upload] refreshLibrary tras crear canal', e);
    }

    // Añadir a LIB local
    const next = [...lib.filter((c) => String(c.id) !== entry.id), entry];
    setLIB(next);
    try { await kv.set('lib', next); } catch (_) {}
    status?.('Canal listo (archivado)');
    return entry;
  }

  function uniqueSorted(arr) {
    return [...new Set(arr.filter(Boolean))].sort(natural || undefined);
  }


  function showUploadFrame() {
    try {
      document.querySelector('.info-frame.upload-frame')?.remove();
      const frame = el('div', 'info-frame upload-frame');
      const box = el('div', 'info-box');
      const head = el('div', 'info-head');
      head.append(el('span', '', 'Subir cómic'));
      const close = el('button', 'btn info-close', '×');
      close.onclick = () => { frame.remove(); };
      head.append(close);

      const body = el('div', 'info-body');
      body.append(el('p', 'cover-pick-hint',
        'Elige un CBZ/CBR del dispositivo. Si el canal no existe se crea (archivado) con el formato Canal:Editorial::Comics::tgstorage.'
      ));

      const lib = Array.isArray(getLIB()) ? getLIB() : [];
      const editorials = uniqueSorted(lib.map((c) => c.group || 'Sin editorial'));
      const channelsByGroup = {};
      for (const c of lib) {
        const g = c.group || 'Sin editorial';
        (channelsByGroup[g] ||= []).push(c);
      }

      // Controles
      const fileBtn = el('button', 'btn cover-pick-device', 'Elegir archivo CBZ / CBR');
      const fileInput = el('input');
      fileInput.type = 'file';
      fileInput.accept = '.cbz,.cbr,application/zip,application/x-rar-compressed,*/*';
      fileInput.hidden = true;
      const fileLabel = el('p', 'sync-status', 'Ningún archivo seleccionado');
      let pickedFile = null;

      const editorialSel = el('select', 'edit-input upload-select');
      const optNewEd = el('option');
      optNewEd.value = '__new__';
      optNewEd.textContent = '+ Nueva editorial…';
      editorialSel.append(optNewEd);
      for (const g of editorials) {
        const o = el('option');
        o.value = g;
        o.textContent = g;
        editorialSel.append(o);
      }
      if (editorials.length) editorialSel.value = editorials[0];
      const editorialInp = el('input', 'edit-input');
      editorialInp.type = 'text';
      editorialInp.placeholder = 'Nombre de la editorial';
      editorialInp.hidden = editorials.length > 0;
      if (!editorials.length) {
        editorialSel.value = '__new__';
        editorialInp.hidden = false;
      }

      const channelSel = el('select', 'edit-input upload-select');
      const channelInp = el('input', 'edit-input');
      channelInp.type = 'text';
      channelInp.placeholder = 'Nombre del canal';
      channelInp.hidden = true;

      const seriesInp = el('input', 'edit-input');
      seriesInp.type = 'text';
      seriesInp.placeholder = 'Serie (ej. Silencio)';
      const numberInp = el('input', 'edit-input');
      numberInp.type = 'text';
      numberInp.placeholder = 'Número / Special / Extra / Anual';
      const infoInp = el('input', 'edit-input');
      infoInp.type = 'text';
      infoInp.placeholder = 'Info opcional';
      const preview = el('p', 'upload-preview', '');

      const asWebpChk = el('input');
      asWebpChk.type = 'checkbox';
      asWebpChk.id = 'upload-as-webp';
      const webpRow = el('label', 'repack-check');
      webpRow.append(asWebpChk, document.createTextNode(' Convertir páginas a WebP (añade [WebP] al nombre)'));

      const status = el('p', 'sync-status', '');
      const actions = el('div', 'edit-actions');
      const cancel = el('button', 'btn', 'Cancelar');
      const goBtn = el('button', 'btn edit-save', 'Subir');

      const updatePreview = () => {
        const ed = editorialSel.value === '__new__' ? editorialInp.value.trim() : editorialSel.value;
        let chName = '';
        if (channelSel.value === '__new__') chName = channelInp.value.trim();
        else {
          const opt = [...channelSel.options].find((o) => o.value === channelSel.value);
          chName = opt?._ch?.name || opt?.textContent || '';
        }
        const fname = composeFileName({
          channel: chName,
          series: seriesInp.value,
          number: numberInp.value,
          info: infoInp.value,
        });
        preview.textContent = 'Archivo: ' + fname;
        preview._fname = fname;
      };

      const rebuildChannels = () => {
        const g = editorialSel.value === '__new__'
          ? (editorialInp.value.trim() || 'Sin editorial')
          : editorialSel.value;
        channelSel.replaceChildren();
        const optNewCh = el('option');
        optNewCh.value = '__new__';
        optNewCh.textContent = '+ Nuevo canal…';
        channelSel.append(optNewCh);
        const list = (channelsByGroup[g] || []).slice().sort((a, b) =>
          (natural || ((x, y) => String(x).localeCompare(String(y))))(a.name, b.name)
        );
        for (const c of list) {
          const o = el('option');
          o.value = c.id;
          o.textContent = c.name;
          o._ch = c;
          channelSel.append(o);
        }
        if (list.length) {
          channelSel.value = list[0].id;
          channelInp.hidden = true;
        } else {
          channelSel.value = '__new__';
          channelInp.hidden = false;
        }
        updatePreview();
      };

      fileBtn.onclick = () => fileInput.click();
      fileInput.onchange = () => {
        pickedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        fileLabel.textContent = pickedFile
          ? (pickedFile.name + ' (' + (formatBytes?.(pickedFile.size) || pickedFile.size + ' B') + ')')
          : 'Ningún archivo seleccionado';
      };
      editorialSel.onchange = () => {
        editorialInp.hidden = editorialSel.value !== '__new__';
        rebuildChannels();
      };
      editorialInp.oninput = () => { if (editorialSel.value === '__new__') rebuildChannels(); else updatePreview(); };
      channelSel.onchange = () => {
        channelInp.hidden = channelSel.value !== '__new__';
        updatePreview();
      };
      channelInp.oninput = updatePreview;
      seriesInp.oninput = updatePreview;
      numberInp.oninput = updatePreview;
      infoInp.oninput = updatePreview;

      cancel.onclick = () => { frame.remove(); };
      goBtn.onclick = async () => {
        if (busy) {
          alert('Ya hay una subida en curso');
          return;
        }
        if (!pickedFile) {
          alert('Selecciona un archivo');
          return;
        }
        const ed = editorialSel.value === '__new__' ? editorialInp.value.trim() : editorialSel.value;
        let chName = channelSel.value === '__new__'
          ? channelInp.value.trim()
          : (([...channelSel.options].find((o) => o.value === channelSel.value)?._ch?.name)
            || ([...channelSel.options].find((o) => o.value === channelSel.value)?.textContent) || '');
        chName = String(chName || '').trim();
        if (!ed) { alert('Indica la editorial'); return; }
        if (!chName) { alert('Indica el canal'); return; }

        updatePreview();
        let outName = preview._fname || composeFileName({
          channel: chName,
          series: seriesInp.value,
          number: numberInp.value,
          info: infoInp.value,
        });
        outName = outName.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/\.cbz$/i.test(outName)) outName = outName.replace(/\.cb[zr]$/i, '') + '.cbz';
        if (!/\.cbz$/i.test(outName)) outName += '.cbz';

        const wantWebp = !!(asWebpChk && asWebpChk.checked);
        if (wantWebp && !/\[WebP\]/i.test(outName)) {
          outName = outName.replace(/\.cbz$/i, ' [WebP].cbz');
        }

        if (!confirm('¿Subir como «' + outName + '» al canal «' + chName + '» (' + ed + ')?')) return;

        const fileRef = pickedFile;
        const runJob = async (ctx) => {
          const st = (msg) => { try { ctx.log(msg); } catch (_) {} try { logLine(msg); } catch (_) {} };
          abort = false;
          st('Preparando canal…');
          ctx.setProgress(10);
          await yieldTick();
          await ctx.waitWhilePaused?.();
          if (ctx.isAborted?.()) throw Object.assign(new Error('cancelado'), { cancelled: true });
          const ch = await ensureChannel(chName, ed, st);
          ctx.setProgress(20);
          st(wantWebp ? 'Convirtiendo a CBZ WebP…' : 'Convirtiendo a CBZ si hace falta…');
          await yieldTick();
          let blob = await localFileToCbzBlob(fileRef, st, { asWebp: wantWebp });
          ctx.setProgress(55);
          await ctx.waitWhilePaused?.();
          st('Subiendo a Telegram…');
          await uploadCbz(ch, outName, blob, '', st);
          blob = null;
          ctx.setProgress(90);
          st('Actualizando listado…');
          try { await fetchFiles(ch); } catch (e) { st('Listado: ' + (e?.message || e)); }
          ctx.setProgress(100);
          st('✓ Subido correctamente');
        };

        frame.remove();
        busy = true;
        abort = false;
        showUploadProgressPanel();
        const logEl = document.getElementById('upload-log');
        if (logEl) logEl.replaceChildren();
        setFill(0);
        logLine('Archivo: ' + fileRef.name);
        logLine('Destino: ' + chName + ' · ' + ed);
        logLine('Nombre final: ' + outName);
        if (wantWebp) logLine('Modo WebP activado');

        if (jobQueue && typeof jobQueue.enqueue === 'function') {
          jobQueue.enqueue({
            type: 'upload',
            label: outName,
            run: async (ctx) => {
              try {
                await runJob(ctx);
              } finally {
                busy = false;
                const btnStop = document.getElementById('upload-stop');
                if (btnStop) btnStop.textContent = 'Cerrar';
                setFill(100);
                syncFloatingUi();
              }
            },
          });
          try { jobQueue.show(); } catch (_) {}
          busy = false;
        } else {
          try {
            await runJob({
              log: logLine,
              setProgress: setFill,
              waitWhilePaused: async () => {},
              isAborted: () => abort,
            });
          } catch (e) {
            if (e?.cancelled) logLine('Cancelado');
            else {
              console.error('[upload]', e);
              logLine('ERROR: ' + (e?.message || e));
            }
          } finally {
            busy = false;
            abort = false;
            const btnStop = document.getElementById('upload-stop');
            if (btnStop) btnStop.textContent = 'Cerrar';
            syncFloatingUi();
          }
        }
      };

      // Montar DOM
      body.append(el('div', 'info-sec', 'Archivo'));
      body.append(fileBtn, fileInput, fileLabel);
      body.append(el('div', 'info-sec', 'Editorial'));
      body.append(editorialSel, editorialInp);
      body.append(el('div', 'info-sec', 'Canal'));
      body.append(channelSel, channelInp);
      body.append(el('div', 'info-sec', 'Título del archivo'));
      body.append(seriesInp, numberInp, infoInp, preview);
      body.append(webpRow);
      body.append(status);
      actions.append(cancel, goBtn);
      body.append(actions);
      box.append(head, body);
      frame.append(box);

      rebuildChannels();
      updatePreview();

      let armed = false;
      setTimeout(() => { armed = true; }, 350);
      frame.addEventListener('click', (ev) => {
        if (!armed) return;
        if (ev.target === frame) frame.remove();
      });
      document.body.append(frame);
    } catch (e) {
      console.error('[upload] showUploadFrame', e);
      alert('No se pudo abrir el formulario de subida: ' + (e?.message || e));
    }
  }

  try {
    window.addEventListener('tgcomic:reader', (ev) => {
      if (ev?.detail?.open) hideFloatingUi();
      else syncFloatingUi();
    });
  } catch (_) {}

  return {
    showUploadFrame,
    composeFileName,
    ensureChannel,
    uploadCbz,
    localFileToCbzBlob,
    syncFloatingUi,
    hideFloatingUi,
  };
}
