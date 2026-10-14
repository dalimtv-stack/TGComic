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
  } = d;
  const getClient = () => d.client;
  const getReady = () => d.ready;
  const getLIB = () => d.LIB;
  const setLIB = (v) => { if (typeof d.setLIB === 'function') d.setLIB(v); };
  if (typeof el !== 'function') {
    throw new Error('createUploadTool: falta el()');
  }

  let busy = false;

  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

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

  async function localFileToCbzBlob(file, status) {
    status?.('Leyendo archivo…');
    const ab = await file.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const name = file.name || 'comic';

    if (isZipHeader(u8) || /\.cbz$/i.test(name)) {
      status?.('Ya es ZIP/CBZ');
      return new Blob([u8], { type: 'application/zip' });
    }

    if (!isRarHeader(u8) && !/\.cbr$/i.test(name)) {
      // Intentar como ZIP por si acaso
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
    const mimeOf = (n) => {
      const e = (n.split(/[/\\]/).pop() || n).toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
      if (!e) return 'application/octet-stream';
      const ext = e[1].toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
      return 'image/' + ext;
    };

    const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
    let nImg = 0;
    for (const x of ex.extract().files) {
      const n = x.fileHeader.name || '';
      if (x.fileHeader.flags.directory || !x.extraction) continue;
      const base = n.split(/[/\\]/).pop() || n;
      if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
      const raw = x.extraction;
      const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (!src.byteLength) continue;
      const copy = new Uint8Array(src.byteLength);
      copy.set(src);
      const pageBlob = new Blob([copy.buffer], { type: mimeOf(base) });
      nImg++;
      await writer.add(base, new zip.BlobReader(pageBlob), { level: 0 });
      if (nImg % 3 === 0) {
        status?.(`Empaquetando… ${nImg} img`);
        await yieldTick();
      }
    }
    if (!nImg) {
      try { await writer.close(); } catch (_) {}
      throw new Error('CBR sin imágenes legibles');
    }
    const out = await writer.close();
    status?.(`CBZ listo (${formatBytes?.(out.size) || out.size + ' B'}, ${nImg} img)`);
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
    close.onclick = () => { if (!busy) frame.remove(); };
    head.append(close);

    const body = el('div', 'info-body');
    body.append(el('p', 'cover-pick-hint',
      'Elige un CBZ/CBR del dispositivo. Si el canal no existe se crea (archivado) con el formato Canal:Editorial::Comics::tgstorage. También puedes subir a un canal ya existente.'
    ));

    const lib = Array.isArray(getLIB()) ? getLIB() : [];
    const editorials = uniqueSorted(lib.map((c) => c.group || 'Sin editorial'));
    const channelsByGroup = {};
    for (const c of lib) {
      const g = c.group || 'Sin editorial';
      (channelsByGroup[g] ||= []).push(c);
    }

    // Archivo
    body.append(el('div', 'info-sec', 'Archivo'));
    const fileBtn = el('button', 'btn cover-pick-device', '📁  Elegir archivo CBZ / CBR');
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.cbz,.cbr,application/zip,application/x-rar-compressed,*/*';
    fileInput.hidden = true;
    const fileLabel = el('p', 'sync-status', 'Ningún archivo seleccionado');
    let pickedFile = null;
    fileBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      pickedFile = fileInput.files?.[0] || null;
      fileLabel.textContent = pickedFile
        ? `${pickedFile.name} (${formatBytes?.(pickedFile.size) || pickedFile.size + ' B'})`
        : 'Ningún archivo seleccionado';
      // Prefill desde nombre de archivo
      if (pickedFile) {
        const base = String(pickedFile.name).replace(/\.cb[zr]$/i, '').replace(/_/g, ' ');
        if (!seriesInp.value) {
          const m = base.match(/^(.+?)\s+#?(\d+[a-z]?|Special|Especial|Extra|Anual|Annual)\b/i)
            || base.match(/^(.+?)\s+(\d+[a-z]?)\s*-/i);
          if (m) {
            seriesInp.value = m[1].replace(new RegExp('^' + (channelSel.value || channelInp.value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-\\s*', 'i'), '').trim() || m[1];
            numberInp.value = m[2];
            const rest = base.slice(m[0].length).replace(/^\s*-\s*/, '').trim();
            if (rest && !infoInp.value) infoInp.value = rest;
          } else if (!seriesInp.value) {
            seriesInp.value = base;
          }
          updatePreview();
        }
      }
    };
    body.append(fileBtn, fileInput, fileLabel);

    // Editorial
    body.append(el('div', 'info-sec', 'Editorial'));
    const editorialSel = el('select', 'edit-input upload-select');
    const optNewEd = el('option');
    optNewEd.value = '__new__';
    optNewEd.textContent = '＋ Nueva editorial…';
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
    editorialSel.onchange = () => {
      editorialInp.hidden = editorialSel.value !== '__new__';
      rebuildChannels();
      updatePreview();
    };
    editorialInp.oninput = updatePreview;
    body.append(editorialSel, editorialInp);

    // Canal
    body.append(el('div', 'info-sec', 'Canal'));
    const channelSel = el('select', 'edit-input upload-select');
    const channelInp = el('input', 'edit-input');
    channelInp.type = 'text';
    channelInp.placeholder = 'Nombre del canal';
    channelInp.hidden = true;
    const rebuildChannels = () => {
      const g = editorialSel.value === '__new__'
        ? (editorialInp.value.trim() || 'Sin editorial')
        : editorialSel.value;
      channelSel.replaceChildren();
      const optNewCh = el('option');
      optNewCh.value = '__new__';
      optNewCh.textContent = '＋ Nuevo canal…';
      channelSel.append(optNewCh);
      const list = (channelsByGroup[g] || []).slice().sort((a, b) => natural(a.name, b.name));
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
    };
    channelSel.onchange = () => {
      channelInp.hidden = channelSel.value !== '__new__';
      updatePreview();
    };
    channelInp.oninput = updatePreview;
    body.append(channelSel, channelInp);
    rebuildChannels();

    // Serie / número / info
    body.append(el('div', 'info-sec', 'Título del archivo'));
    const seriesInp = el('input', 'edit-input');
    seriesInp.type = 'text';
    seriesInp.placeholder = 'Serie (ej. Silencio)';
    const numberInp = el('input', 'edit-input');
    numberInp.type = 'text';
    numberInp.placeholder = 'Número / Special / Extra / Anual';
    const infoInp = el('input', 'edit-input');
    infoInp.type = 'text';
    infoInp.placeholder = 'Info opcional (ej. Dos caras)';
    const preview = el('p', 'upload-preview', '');
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
      preview.textContent = `Archivo: ${fname}`;
      preview._fname = fname;
      preview._channel = chName;
      preview._editorial = ed || 'Sin editorial';
    };
    seriesInp.oninput = updatePreview;
    numberInp.oninput = updatePreview;
    infoInp.oninput = updatePreview;
    body.append(seriesInp, numberInp, infoInp, preview);
    updatePreview();

    const status = el('p', 'sync-status', '');
    body.append(status);

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => { if (!busy) frame.remove(); };
    const goBtn = el('button', 'btn edit-save', 'Subir');
    goBtn.onclick = async () => {
      if (busy) return;
      if (!pickedFile) {
        alert('Selecciona un archivo');
        return;
      }
      const ed = editorialSel.value === '__new__'
        ? editorialInp.value.trim()
        : editorialSel.value;
      let chName = channelSel.value === '__new__'
        ? channelInp.value.trim()
        : ([...channelSel.options].find((o) => o.value === channelSel.value)?._ch?.name
          || [...channelSel.options].find((o) => o.value === channelSel.value)?.textContent || '');
      chName = String(chName || '').trim();
      if (!ed) {
        alert('Indica la editorial');
        return;
      }
      if (!chName) {
        alert('Indica el canal');
        return;
      }
      updatePreview();
      let outName = preview._fname || composeFileName({
        channel: chName,
        series: seriesInp.value,
        number: numberInp.value,
        info: infoInp.value,
      });
      outName = outName.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      if (!/\.cbz$/i.test(outName)) outName = outName.replace(/\.cb[zr]$/i, '') + '.cbz';

      if (!confirm(`¿Subir como «${outName}» al canal «${chName}» (${ed})?`)) return;

      busy = true;
      goBtn.disabled = true;
      cancel.disabled = true;
      close.disabled = true;
      const st = (t) => { status.textContent = t; };

      try {
        const ch = await ensureChannel(chName, ed, st);
        let blob = await localFileToCbzBlob(pickedFile, st);
        await uploadCbz(ch, outName, blob, '', st);
        blob = null;
        st('Actualizando listado…');
        try { await fetchFiles(ch); } catch (_) {}
        st('✓ Subido correctamente');
        setTimeout(() => frame.remove(), 900);
      } catch (e) {
        console.error('[upload]', e);
        status.textContent = 'Error: ' + (e?.message || e);
        status.classList.add('sync-err');
        goBtn.disabled = false;
        cancel.disabled = false;
        close.disabled = false;
      } finally {
        busy = false;
      }
    };
    actions.append(cancel, goBtn);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    // Evitar que el mismo toque/clic que abrió el menú cierre el frame al instante
    let armed = false;
    setTimeout(() => { armed = true; }, 350);
    frame.addEventListener('click', (ev) => {
      if (!armed || busy) return;
      if (ev.target === frame) frame.remove();
    });
    document.body.append(frame);
    } catch (e) {
      console.error('[upload] showUploadFrame', e);
      alert('No se pudo abrir el formulario de subida: ' + (e?.message || e));
    }
  }

  return {
    showUploadFrame,
    composeFileName,
    ensureChannel,
    uploadCbz,
    localFileToCbzBlob,
    syncFloatingUi() {},
    hideFloatingUi() {},
  };
}
