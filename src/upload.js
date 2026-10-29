/**
 * Subida de cómics nuevos a Telegram (CBZ).
 * - Convierte CBR → CBZ si hace falta
 * - Crea canal si no existe: Nombre:Editorial::Comics::tgstorage
 * - Composición de nombre: [Canal] - [Serie] #n - [Info].cbz
 */
import * as zip from '@zip.js/zip.js';
import { createExtractorFromData } from 'node-unrar-js';
import rarWasm from 'node-unrar-js/esm/js/unrar.wasm?url';
import { buildComicCaption } from './parse.js';
import { fitTelegramCaption } from './caption.js';
import { withQualityTags, stripQualityTags, existingCopy, flattenVersions, parseQuality, QUALITY_LABEL } from './quality.js';

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
    onUploadDone,
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

  async function blobToWebp(blob, opts = {}) {
    if (!blob || !blob.size) return blob;
    if ((blob.type || '').includes('webp') && blob.size < 1.5 * 1024 * 1024) return blob;
    const quality = Number(opts.quality);
    const q = Number.isFinite(quality) && quality > 0 && quality <= 1 ? quality : 0.40;
    const doResize = opts.resize !== false;
    const maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : 2400;
    let bmp = null;
    try {
      bmp = await createImageBitmap(blob);
      const scale = doResize
        ? Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
        : 1;
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d', { alpha: false });
      ctx.drawImage(bmp, 0, 0, w, h);
      try { bmp.close?.(); } catch (_) {}
      bmp = null;
      let out = await new Promise((res) => {
        try { cv.toBlob((b) => res(b), 'image/webp', q); }
        catch { res(null); }
      });
      // Safari: toBlob('image/webp') puede devolver PNG o fallar → no tratarlo como WebP
      if (!(out && out.size && (out.type || '').includes('webp'))) {
        out = await new Promise((res) => {
          try { cv.toBlob((b) => res(b), 'image/jpeg', Math.min(0.92, q + 0.2)); }
          catch { res(null); }
        });
      }
      cv.width = 0;
      cv.height = 0;
      await yieldTick();
      return out && out.size ? out : blob;
    } catch {
      try { bmp?.close?.(); } catch (_) {}
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

  /** Quita extensiones (.cbr/.cbz/.zip/.rar/…) y deja un solo .cbz (opcional [WebP]). */
  function ensureCbzName(name, wantWebp, resize) {
    let s = String(name || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\.(cb[zr]|zip|rar|7z|tar|gz|cb7)+$/ig, '').trim();
    s = stripQualityTags(s);
    // Quitar cualquier cola de extensiones conocidas (también repetidas)
    let prev;
    do {
      prev = s;
      s = s.replace(/\.(cb[zr]|zip|rar|7z|tar|gz|cb7)+$/ig, '').trim();
    } while (s !== prev);
    if (wantWebp) s = s + (resize ? ' [2400px][WebP]' : ' [WebP]');
    return s.trim() + '.cbz';
  }

  // Como antes: Serie #Número - Info
  function composeFileName({ channel, series, number, info, asWebp, resize }) {
    const ch = String(channel || '').trim();
    const ser = String(series || '').trim();
    const num = String(number || '').trim();
    // Quitar guiones sueltos al inicio/final del info (evita "#001 - - [Traducido]")
    const inf = String(info || '')
      .replace(/^\s*[-–—:]+\s*/g, '')
      .replace(/\s*[-–—:]+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    let body = '';
    if (ser && num) body = `${ser} #${num}`;
    else if (ser) body = ser;
    else if (num) body = `#${num}`;
    else body = 'comic';
    if (inf) body += ` - ${inf}`;
    const base = (ch && ser) ? `${ch} - ${body}` : body;
    return ensureCbzName(base, !!asWebp, !!resize);
  }

  /**
   * Como el formulario de un solo archivo:
   * { series, number, info } — info = texto tras el #n + [tags]
   * seriesHint = serie del contexto (vista serie); si no, se saca del nombre.
   */
  function parseUploadBase(fileName, channelName, seriesHint) {
    let base = String(fileName || '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Quitar extensión real del archivo (.cbr, .zip, .rar, …)
    let prev;
    do {
      prev = base;
      base = base.replace(/\.(cb[zr]|zip|rar|7z|tar|gz|cb7)+$/ig, '').trim();
    } while (base !== prev);
    base = base.replace(/\s*@\S+/g, '').trim();
    base = base.replace(/\s*\[WebP\]/ig, '').trim();
    const extras = [];
    base = base.replace(/\s*\[([^\]]+)\]/g, (_, inner) => {
      const t = String(inner || '').trim();
      if (t && !/^webp$/i.test(t)) extras.push(t);
      return ' ';
    }).replace(/\s+/g, ' ').trim();
    // Tras quitar [Traducido] etc. queda a menudo "Serie #001 -" → limpiar guiones/colons sobrantes
    base = base
      .replace(/\s*[-–—:]+\s*$/g, '')
      .replace(/\s*[-–—:]+\s*(?=\[)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const chName = String(channelName || '').trim();
    if (chName) {
      const low = base.toLowerCase();
      const chLow = chName.toLowerCase();
      if (low.startsWith(chLow)) {
        base = base.slice(chName.length).replace(/^\s*-\s*/, '').trim();
      }
    }

    const ISSUE_TAG = '(?:\\d+(?:\\.\\d+)?[a-zA-Z]?(?![\\w.])|(?:Special|Especial|Extras|Extra|Anual|Annual|[OÓoó]mnibus|Integral|One[\\s-]?Shot|OneShot)(?![A-Za-zÀ-ÿ]))';
    const tags = extras.length ? extras.map((x) => '[' + x + ']').join(' ') : '';
    const cleanInfoPart = (s) => String(s || '')
      .replace(/^\s*[-–—:]+\s*/g, '')
      .replace(/\s*[-–—:]+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const joinInfo = (a, b) => [cleanInfoPart(a), cleanInfoPart(b)].filter(Boolean).join(' ').trim();
    const hint = String(seriesHint || '').trim();

    // Contexto de serie: el resto del nombre es #n / info
    if (hint) {
      let rest = base;
      if (rest.toLowerCase().startsWith(hint.toLowerCase())) {
        rest = rest.slice(hint.length).replace(/^\s*-\s*/, '').trim();
      }
      let m = rest.match(new RegExp(`^#\\s*(${ISSUE_TAG})(?:\\s*[-–—:]?\\s+(.*)|\\s*[-–—:]\\s*(.*))?$`, 'i'));
      if (!m) m = rest.match(new RegExp(`^(${ISSUE_TAG})(?:\\s*[-–—:]?\\s+(.*)|\\s*[-–—:]\\s*(.*))?$`, 'i'));
      if (m) {
        return {
          series: hint,
          number: String(m[1] || '').trim(),
          info: joinInfo(String(m[2] || m[3] || '').trim(), tags),
        };
      }
      if (!rest || rest.toLowerCase() === hint.toLowerCase()) {
        return { series: hint, number: '', info: tags };
      }
    }

    // Del nombre de archivo: Serie #n - info
    let m = null;
    if (/#/.test(base)) {
      m = base.match(new RegExp(`^(.*)\\s*#\\s*(${ISSUE_TAG})(?:\\s*[-–—:]?\\s+(.*)|\\s*[-–—:]\\s*(.*))?$`, 'i'));
    }
    if (m) m = [m[0], m[1], m[2], m[3] || m[4] || ''];
    if (!m) m = base.match(/^(.*?)\s+(\d{1,4}[a-z]?)\s*[-–—]\s+(.*)$/i);
    if (!m) m = base.match(/^(.*?)\s+(\d{1,4}[a-z]?)$/i);
    if (m) {
      // Tras quitar el canal del nombre queda "#01" → series vacía: usar nombre del canal
      let series = String(m[1] || '').trim();
      if (!series && chName) series = chName;
      return {
        series,
        number: String(m[2] || '').trim(),
        info: joinInfo(String(m[3] || '').trim(), tags),
      };
    }
    // Solo "#01" o "01" tras quitar canal
    const onlyNum = base.match(new RegExp(`^#?\\s*(${ISSUE_TAG})$`, 'i'));
    if (onlyNum) {
      return {
        series: chName || '',
        number: String(onlyNum[1] || '').trim(),
        info: tags,
      };
    }
    return { series: base || chName || '', number: '', info: tags };
  }

  const isGramNoise = (e) => /Missing MTProto Entity|TL definition for ID 0/i.test(String(e?.message || e || ''));
  /** GramJS a veces lanza un error de parseo DESPUÉS de enviar: el mensaje ya está en Telegram, no reintentar (duplicaría la subida). */
  async function sendFileSafe(client, peer, opts) {
    try {
      return await client.sendFile(peer, opts);
    } catch (e) {
      if (isGramNoise(e)) {
        console.warn('[upload] aviso interno GramJS tras enviar (mensaje enviado):', e?.message || e);
        return null;
      }
      throw e;
    }
  }

  function uiAlert(msg) {
    if (typeof window.appAlert === 'function') return window.appAlert(String(msg || ''));
    alert(String(msg || ''));
    return Promise.resolve();
  }
  function uiConfirm(msg) {
    if (typeof window.appConfirm === 'function') return window.appConfirm(String(msg || ''));
    return Promise.resolve(confirm(String(msg || '')));
  }

  function isRarHeader(u8) {
    return u8 && u8.length >= 4 && u8[0] === 0x52 && u8[1] === 0x61 && u8[2] === 0x72 && u8[3] === 0x21;
  }
  function isZipHeader(u8) {
    return u8 && u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b;
  }

  async function localFileToCbzBlob(file, status, opts) {
    const wantWebp = !!(opts && opts.asWebp);
    const webpOpts = (opts && opts.webpOpts) || {};
    status?.('Leyendo archivo…');
    await yieldTick();

    const mimeOf = (n) => {
      const e = (String(n).split(/[/\\]/).pop() || n).toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)$/);
      if (!e) return 'application/octet-stream';
      const ext = e[1].toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
      return 'image/' + ext;
    };

    const name = file.name || 'comic';

    // --- CBZ / ZIP: leer entradas una a una ---
    async function fromZipBlob(zipBlob) {
      const reader = new zip.ZipReader(new zip.BlobReader(zipBlob));
      let entries;
      try {
        entries = await reader.getEntries();
      } catch (e) {
        try { await reader.close(); } catch (_) {}
        throw e;
      }
      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
        bufferedWrite: true,
        level: 0,
      });
      let nImg = 0;
      try {
        for (const e of entries) {
          if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
          if (e.directory) continue;
          const base = (e.filename || '').split(/[/\\]/).pop() || e.filename;
          if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
          let pageBlob = await e.getData(new zip.BlobWriter());
          let outName = base;
          if (wantWebp) {
            const origSize = pageBlob.size || 0;
            const converted = await blobToWebp(pageBlob, webpOpts);
            // Solo usar WebP si realmente reduce tamaño (si no, se queda la original)
            if (converted && converted.size && converted.size < origSize * 0.98) {
              pageBlob = converted;
              outName = base.replace(/\.[^.]+$/i, '.webp');
            }
          }
          nImg++;
          await writer.add(outName, new zip.BlobReader(pageBlob), { level: 0 });
          pageBlob = null;
          if (nImg % 1 === 0) {
            status?.(wantWebp ? ('WebP… ' + nImg + ' img') : ('Empaquetando… ' + nImg + ' img'));
            await yieldTick();
            // Pausa extra cada 3 páginas para dejar respirar al GC
            if (nImg % 3 === 0) await new Promise((r) => setTimeout(r, 30));
          }
        }
      } finally {
        try { await reader.close(); } catch (_) {}
      }
      if (!nImg) {
        try { await writer.close(); } catch (_) {}
        throw new Error('Sin imágenes legibles');
      }
      const out = await writer.close();
      status?.('CBZ listo (' + (formatBytes?.(out.size) || out.size + ' B') + ', ' + nImg + ' img)' + (wantWebp ? ' WebP' : ''));
      return out;
    }

    // --- CBR / RAR ---
    async function fromRarBytes(u8) {
      status?.('Extrayendo CBR…');
      await yieldTick();
      const dataAb = u8.buffer.byteLength === u8.byteLength && u8.byteOffset === 0
        ? u8.buffer
        : u8.slice().buffer;
      const ex = await createExtractorFromData({
        wasmBinary: await (await fetch(rarWasm)).arrayBuffer(),
        data: dataAb,
      });
      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
        bufferedWrite: true,
        level: 0,
      });
      let nImg = 0;
      const files = ex.extract().files;
      for (const x of files) {
        if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
        const n = x.fileHeader.name || '';
        if (x.fileHeader.flags.directory || !x.extraction) continue;
        const base = n.split(/[/\\]/).pop() || n;
        if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
        const raw = x.extraction;
        const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (!src.byteLength) continue;
        // copiar y soltar referencia al buffer interno del rar
        const copy = new Uint8Array(src.byteLength);
        copy.set(src);
        let pageBlob = new Blob([copy.buffer], { type: mimeOf(base) });
        let outName = base;
        if (wantWebp) {
          const origSize = pageBlob.size || 0;
          const converted = await blobToWebp(pageBlob, webpOpts);
          if (converted && converted.size && converted.size < origSize * 0.98) {
            pageBlob = converted;
            outName = base.replace(/\.[^.]+$/i, '.webp');
          }
        }
        nImg++;
        await writer.add(outName, new zip.BlobReader(pageBlob), { level: 0 });
        pageBlob = null;
        status?.(wantWebp ? ('WebP… ' + nImg + ' img') : ('Empaquetando… ' + nImg + ' img'));
        await yieldTick();
        if (nImg % 3 === 0) await new Promise((r) => setTimeout(r, 30));
      }
      if (!nImg) {
        try { await writer.close(); } catch (_) {}
        throw new Error('CBR sin imágenes legibles');
      }
      const out = await writer.close();
      status?.('CBZ listo (' + (formatBytes?.(out.size) || out.size + ' B') + ', ' + nImg + ' img)' + (wantWebp ? ' WebP' : ''));
      return out;
    }

    // Cabeceras sin cargar todo si es File grande: usamos el File/Blob directo para ZIP
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const isZip = isZipHeader(head) || /\.cbz$/i.test(name);
    const isRar = isRarHeader(head) || /\.cbr$/i.test(name);

    if (isZip) {
      if (!wantWebp) {
        status?.('Ya es ZIP/CBZ');
        return file instanceof Blob ? file : new Blob([file], { type: 'application/zip' });
      }
      status?.('Descomprimiendo CBZ → WebP → CBZ…');
      return fromZipBlob(file instanceof Blob ? file : new Blob([file]));
    }

    if (isRar) {
      status?.('Leyendo CBR en memoria…');
      const ab = await file.arrayBuffer();
      const u8 = new Uint8Array(ab);
      try {
        return await fromRarBytes(u8);
      } finally {
        // ayudar al GC
      }
    }

    // Último intento: tratar como zip
    if (isZipHeader(head)) {
      return file instanceof Blob ? file : new Blob([await file.arrayBuffer()], { type: 'application/zip' });
    }
    throw new Error('Formato no soportado (usa CBZ o CBR)');
  }

  // fitTelegramCaption: ver caption.js (la Descripción siempre se sube; se recorta con "...")

  function isCaptionTooLongError(e) {
    const m = String(e?.message || e || '');
    return /MEDIA_CAPTION_TOO_LONG|CAPTION_TOO_LONG/i.test(m);
  }

  async function uploadCbz(ch, fileName, blob, caption, status) {
    await getReady();
    const peer = peerOf(ch);
    const client = getClient();
    if (!blob || !blob.size) throw new Error('Archivo vacío');
    status?.(`Preparando subida… (${formatBytes?.(blob.size) || blob.size + ' B'})`);

    let captionSafe = fitTelegramCaption(caption || '', 1024);
    if ((caption || '').length > captionSafe.length) {
      status?.(`Caption recortado a ${captionSafe.length}/1024 caracteres (límite Telegram)`);
    }

    const attrs = [new Api.DocumentAttributeFilename({ fileName })];
    const onProg = (p) => {
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      const n = Number(p);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        status?.(`Subiendo… ${Math.min(100, Math.round(n * 100))}%`);
      }
    };

    const sendWithCaption = async (fileRef, cap) => {
      try {
        await sendFileSafe(client, peer, {
          file: fileRef,
          caption: cap || '',
          forceDocument: true,
          attributes: attrs,
        });
        return true;
      } catch (e) {
        if (isCaptionTooLongError(e)) {
          // Reintentos más agresivos: 900 → 512 → sin caption
          for (const lim of [900, 512, 0]) {
            const short = lim === 0 ? '' : fitTelegramCaption(cap, lim);
            status?.(`Caption demasiado largo; reintento con ${short.length}/1024…`);
            try {
              await sendFileSafe(client, peer, {
                file: fileRef,
                caption: short,
                forceDocument: true,
                attributes: attrs,
              });
              return true;
            } catch (e2) {
              if (!isCaptionTooLongError(e2)) throw e2;
            }
          }
        }
        throw e;
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
      await sendWithCaption(inputFile, captionSafe);
      return;
    } catch (e) {
      if (e?.cancelled || abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      console.warn('[upload] uploadFile(File) falló', e);
      // Si el fallo fue solo caption y ya se agotaron reintentos, no confundir con CustomFile
      if (isCaptionTooLongError(e)) {
        throw new Error('Caption demasiado largo para Telegram (máx. 1024). Acorta la descripción.');
      }
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
    if (!CustomFile) {
      // Último recurso: sendFile directo con File del navegador
      try {
        const browserFile = new File([blob], fileName, { type: blob.type || 'application/zip' });
        status?.('Subiendo (sendFile directo)…');
        await sendFileSafe(client, peer, {
          file: browserFile,
          caption: captionSafe,
          forceDocument: true,
          workers: 1,
          attributes: attrs,
          progressCallback: onProg,
        });
        return;
      } catch (e) {
        if (isCaptionTooLongError(e)) {
          throw new Error('Caption demasiado largo para Telegram (máx. 1024). Acorta la descripción.');
        }
        throw new Error('CustomFile no disponible: ' + (e?.message || e));
      }
    }

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
      await sendWithCaption(inputFile, captionSafe);
      return;
    } catch (e) {
      if (e?.cancelled || abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      console.warn('[upload] CustomFile falló', e);
      if (isCaptionTooLongError(e)) {
        throw new Error('Caption demasiado largo para Telegram (máx. 1024). Acorta la descripción.');
      }
      status?.(`Reintento sendFile… (${e?.message || e})`);
    }

    await sendFileSafe(client, peer, {
      file: custom,
      caption: captionSafe,
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
            // Mensaje inicial con el nombre del canal (como tgstorage), antes de subir cómics
            try {
              status?.('Mensaje inicial en el canal…');
              const peer = peerOf(again);
              await client.sendMessage(peer, { message: name });
            } catch (e) {
              console.warn('[upload] no se pudo enviar el mensaje inicial del canal', e);
            }
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

    // Mensaje inicial solo en canal recién creado (nombre del canal, p.ej. "Ex Machina")
    try {
      status?.('Mensaje inicial en el canal…');
      const peer = peerOf(entry);
      await client.sendMessage(peer, { message: name });
    } catch (e) {
      console.warn('[upload] no se pudo enviar el mensaje inicial del canal', e);
      status?.('Canal listo (sin mensaje inicial: ' + (e?.message || e) + ')');
    }

    status?.('Canal listo (archivado)');
    return entry;
  }

  function uniqueSorted(arr) {
    return [...new Set(arr.filter(Boolean))].sort(natural || undefined);
  }


  function showUploadFrame(ctx = {}) {
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
        'Puedes elegir varios CBZ/CBR de la misma serie. Si el canal no existe se crea (archivado) con el formato Canal:Editorial::Comics::tgstorage.'
      ));

      const ctxEditorial = String(ctx?.editorial || '').trim();
      const ctxChannel = ctx?.channel || null;
      const ctxSeries = String(ctx?.series || '').trim();

      const lib = Array.isArray(getLIB()) ? getLIB() : [];
      const editorials = uniqueSorted(lib.map((c) => c.group || 'Sin editorial'));
      const channelsByGroup = {};
      for (const c of lib) {
        const g = c.group || 'Sin editorial';
        (channelsByGroup[g] ||= []).push(c);
      }

      const fileBtn = el('button', 'btn cover-pick-device', 'Elegir archivo(s) CBZ / CBR');
      const fileInput = el('input');
      fileInput.type = 'file';
      fileInput.accept = '.cbz,.cbr,application/zip,application/x-rar-compressed,*/*';
      fileInput.multiple = true;
      fileInput.hidden = true;
      const fileLabel = el('p', 'sync-status', 'Ningún archivo seleccionado');

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

      // Serie GLOBAL (misma para todos los archivos): contexto de la vista o del nombre del archivo
      const seriesLab = el('div', 'sync-label', 'Serie');
      const seriesHint = el('p', 'cover-pick-hint', 'Común a todos los archivos de esta subida. Se rellena desde la serie en la que estás o desde el nombre del archivo.');
      const seriesInp = el('input', 'edit-input');
      seriesInp.type = 'text';
      seriesInp.placeholder = 'Serie';
      seriesInp.setAttribute('aria-label', 'Serie');
      // Preferir siempre el contexto de navegación (vista serie)
      if (ctxSeries) seriesInp.value = ctxSeries;

      const includeChChk = el('input');
      includeChChk.type = 'checkbox';
      includeChChk.checked = false; // por defecto SIN prefijo de canal
      const includeChRow = el('label', 'repack-check');
      includeChRow.append(includeChChk, document.createTextNode(' Incluir nombre del canal en el archivo'));

      const asWebpChk = el('input');
      asWebpChk.type = 'checkbox';
      const webpRow = el('label', 'repack-check');
      webpRow.append(asWebpChk, document.createTextNode(' Convertir páginas a WebP (añade [WebP] al nombre)'));
      const webpOptsBox = el('div', 'webp-opts');
      webpOptsBox.hidden = true;
      const qualityLab = el('label', 'sync-label', 'Calidad');
      const qualityInp = el('input', 'edit-input');
      qualityInp.type = 'text';
      qualityInp.value = '0.40';
      const resizeRow = el('label', 'repack-check');
      const resizeCb = el('input');
      resizeCb.type = 'checkbox';
      resizeCb.checked = true;
      resizeRow.append(resizeCb, document.createTextNode(' Redimensionar (lado mayor máx. 2400 px)'));
      webpOptsBox.append(qualityLab, qualityInp, resizeRow);
      asWebpChk.onchange = () => { webpOptsBox.hidden = !asWebpChk.checked; };

      const filesSec = el('div', 'info-sec', 'Cómics a subir');
      const filesHint = el('p', 'cover-pick-hint', 'Por cada archivo: número, info y ficha de caption (opcional). La serie de arriba es común.');
      const filesList = el('div', 'upload-files-list');

      /** @type {any[]} */
      let rows = [];

      /** Identificar: mismo frame que en Ficha Telegram (info.js). */
      const identifyForRow = (row) => {
        const pick = typeof d.showComicVinePicker === 'function' ? d.showComicVinePicker : null;
        if (!pick) {
          uiAlert('Identificar no disponible (showComicVinePicker no inyectado).');
          return;
        }
        const seriesQ = seriesInp.value.trim() || ctxSeries || '';
        const numberQ = String(row.numberInp?.value || '').trim();
        const chName = currentChannelName();
        pick(
          { name: chName },
          { name: row.file?.name || '', caption: '' },
          {
            series: seriesQ,
            number: numberQ,
            fileName: row.file?.name || '',
            channelName: chName,
            onPick: (detail) => {
              if (!detail) return;
              const num = String(detail.issueNumber || '').replace(/^#/, '').trim();
              const story = String(detail.name || '').trim();
              let titleLine = '';
              if (num && story) titleLine = '#' + num + ' - ' + story;
              else if (num) titleLine = '#' + num;
              else titleLine = story;

              if (row.titleEsCtrl) {
                row.titleEsCtrl.cv = titleLine;
                row.origCtrl.cv = titleLine;
                row.seriesCtrl.cv = detail.volume || seriesQ || '';
                row.writerCtrl.cv = (detail.writers && detail.writers.length) ? detail.writers.join(' | ') : '';
                row.artistCtrl.cv = (detail.artists && detail.artists.length) ? detail.artists.join(' | ') : '';
                row.pubCtrl.cv = detail.publisher || '';
                row.dateCtrl.cv = detail.coverDate || '';
                row.descCtrl.cv = detail.description || '';
                row.setSelectMode?.(true);
                for (const c of (row.fieldCtrls || [])) {
                  // Editorial / Serie / Título España desmarcados por defecto
                  const key = c === row.titleEsCtrl || c === row.seriesCtrl || c === row.pubCtrl
                    ? false
                    : !!(c.cv && String(c.cv).trim());
                  // User previously wanted Editorial, Serie, Título España unchecked by default
                  let checked = !!(c.cv && String(c.cv).trim());
                  if (c === row.titleEsCtrl || c === row.seriesCtrl || c === row.pubCtrl) checked = false;
                  c.chk.checked = checked;
                  c.apply();
                }
              } else {
                if (row.titleEsInp) row.titleEsInp.value = titleLine;
                if (row.origInp) row.origInp.value = titleLine;
                if (row.capSeriesInp) row.capSeriesInp.value = detail.volume || seriesQ || '';
                if (row.writerInp) row.writerInp.value = (detail.writers && detail.writers.length) ? detail.writers.join(' | ') : '';
                if (row.artistInp) row.artistInp.value = (detail.artists && detail.artists.length) ? detail.artists.join(' | ') : '';
                if (row.pubInp) row.pubInp.value = detail.publisher || '';
                if (row.dateInp) row.dateInp.value = detail.coverDate || '';
                if (row.descInp) row.descInp.value = detail.description || '';
              }
              if (num && row.numberInp && !row.numberInp.value) {
                row.numberInp.value = num;
                try { updateRowPreview(row); } catch (_) {}
              }
            },
          }
        );
      };

      const currentChannelName = () => {
        if (channelSel.value === '__new__') return channelInp.value.trim();
        const opt = [...channelSel.options].find((o) => o.value === channelSel.value);
        return (opt?._ch?.name || opt?.textContent || '').trim();
      };

      const updateRowPreview = (row) => {
        if (row.nameTouched) return;
        const chName = includeChChk.checked ? currentChannelName() : '';
        row.nameInp.value = composeFileName({
          channel: chName,
          series: seriesInp.value,
          number: row.numberInp.value,
          info: row.infoInp.value,
          asWebp: !!asWebpChk.checked,
          resize: !!resizeCb.checked,
        });
      };

      const updateAllPreviews = () => {
        for (const row of rows) updateRowPreview(row);
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
        updateAllPreviews();
      };

      const addFileRow = (file, parsed) => {
        const rowEl = el('div', 'upload-file-row');
        const head = el('div', 'upload-file-name', file.name);
        const meta = el('small', '', (formatBytes?.(file.size) || file.size + ' B'));
        head.append(document.createTextNode(' · '), meta);

        const nLab = el('div', 'sync-label', 'Número');
        const numberInp = el('input', 'edit-input');
        numberInp.type = 'text';
        numberInp.placeholder = 'Número / Special / Extra / Anual';
        numberInp.value = parsed.number || '';

        const iLab = el('div', 'sync-label', 'Info opcional');
        const infoInp = el('input', 'edit-input');
        infoInp.type = 'text';
        infoInp.placeholder = 'Info opcional';
        infoInp.value = parsed.info || '';

        const nameLab = el('div', 'sync-label', 'Nombre final');
        const nameInp = el('input', 'edit-input upload-preview');
        nameInp.type = 'text';
        let nameTouched = false;
        nameInp.oninput = () => { nameTouched = true; row.nameTouched = true; };

        // Ficha caption por archivo (como Editar cómic: check = dato CV, sin check = parseo/local)
        const fichaChk = el('input');
        fichaChk.type = 'checkbox';
        fichaChk.checked = false;
        const fichaLab = el('label', 'repack-check');
        fichaLab.append(fichaChk, document.createTextNode(' Añadir ficha al caption (Telegram)'));
        const fichaBox = el('div', 'meta-telegram-box');
        fichaBox.hidden = true;
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
            inp = el('textarea', 'edit-input meta-desc');
            inp.rows = 3;
          } else {
            inp = el('input', 'edit-input');
            inp.type = 'text';
            inp.autocomplete = 'off';
          }
          const prev = prevVal != null ? String(prevVal) : '';
          inp.value = prev;
          if (ph) inp.placeholder = ph;
          wrap.append(inp);
          fichaBox.append(wrap);
          const ctrl = {
            chk, inp, prev, cv: '',
            apply() {
              if (chk.hidden) return;
              inp.value = chk.checked ? (ctrl.cv || '') : ctrl.prev;
            },
          };
          chk.onchange = () => ctrl.apply();
          fieldCtrls.push(ctrl);
          return ctrl;
        };

        const edDefault = editorialSel.value === '__new__'
          ? editorialInp.value.trim()
          : editorialSel.value;
        // Valores previos del parseo / contexto (como en Editar cómic)
        const prevTitle = (() => {
          const num = parsed.number || '';
          // Título/ficha sin etiquetas [..] ni (año)(Digital)…
          const info = String(parsed.info || '')
            .replace(/\s*\[[^\]]*\]/g, '')
            .replace(/\s*\([^)]*\)/g, '')
            .replace(/\s+/g, ' ')
            .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '')
            .trim();
          if (num && info) return '#' + num + ' - ' + info;
          if (num) return '#' + num;
          return info || '';
        })();
        const prevSeries = seriesInp.value.trim() || ctxSeries || parsed.series || '';
        const prevPub = edDefault || '';

        const titleEsCtrl = mkField('Título España', prevTitle);
        const origCtrl = mkField('Título original', prevTitle);
        const seriesCtrl = mkField('Serie', prevSeries);
        const writerCtrl = mkField('Guionista', '', 'Nombre1 | Nombre2');
        const artistCtrl = mkField('Dibujante', '', 'Nombre1 | Nombre2');
        const pubCtrl = mkField('Editorial', prevPub);
        const dateCtrl = mkField('Fecha de publicación', '', 'MM/AAAA o AAAA');
        const descCtrl = mkField('Descripción', '', '', true);

        const selBar = el('div', 'meta-sel-bar');
        selBar.hidden = true;
        const btnAll = el('button', 'btn', 'Seleccionar todos');
        btnAll.type = 'button';
        const btnNone = el('button', 'btn', 'Ninguno');
        btnNone.type = 'button';
        selBar.append(btnAll, btnNone);
        fichaBox.prepend(selBar);
        const selHint = el('p', 'cover-pick-hint meta-sel-hint', 'Marcado = dato de Comic Vine. Sin marcar = parseo / datos locales.');
        selHint.hidden = true;
        fichaBox.insertBefore(selHint, selBar.nextSibling);

        const setSelectMode = (on) => {
          selBar.hidden = !on;
          selHint.hidden = !on;
          for (const c of fieldCtrls) {
            c.chk.hidden = !on;
            if (!on) c.chk.checked = false;
          }
        };
        btnAll.onclick = () => {
          for (const c of fieldCtrls) { c.chk.checked = true; c.apply(); }
        };
        btnNone.onclick = () => {
          for (const c of fieldCtrls) { c.chk.checked = false; c.apply(); }
        };

        const idBtn = el('button', 'btn-identify', 'Identificar');
        idBtn.type = 'button';
        idBtn.hidden = true;
        fichaChk.onchange = () => {
          fichaBox.hidden = !fichaChk.checked;
          idBtn.hidden = !fichaChk.checked;
          if (fichaChk.checked) {
            // Refrescar prev locales si el usuario cambió serie/editorial globales
            const ser = seriesInp.value.trim() || ctxSeries || parsed.series || '';
            const pub = editorialSel.value === '__new__'
              ? editorialInp.value.trim()
              : editorialSel.value;
            if (!seriesCtrl.inp.value) {
              seriesCtrl.prev = ser;
              seriesCtrl.inp.value = ser;
            }
            if (!pubCtrl.inp.value) {
              pubCtrl.prev = pub;
              pubCtrl.inp.value = pub;
            }
          }
        };

        const row = {
          file, numberInp, infoInp, nameInp, nameTouched: false, rowEl,
          fichaChk, fichaBox, idBtn, fieldCtrls, setSelectMode,
          titleEsInp: titleEsCtrl.inp,
          origInp: origCtrl.inp,
          capSeriesInp: seriesCtrl.inp,
          writerInp: writerCtrl.inp,
          artistInp: artistCtrl.inp,
          pubInp: pubCtrl.inp,
          dateInp: dateCtrl.inp,
          descInp: descCtrl.inp,
          titleEsCtrl, origCtrl, seriesCtrl, writerCtrl, artistCtrl, pubCtrl, dateCtrl, descCtrl,
        };
        idBtn.onclick = () => identifyForRow(row);
        numberInp.oninput = () => { row.nameTouched = false; nameTouched = false; updateRowPreview(row); };
        infoInp.oninput = () => { row.nameTouched = false; nameTouched = false; updateRowPreview(row); };

        rowEl.append(head, nLab, numberInp, iLab, infoInp, nameLab, nameInp, fichaLab, idBtn, fichaBox);
        filesList.append(rowEl);
        rows.push(row);
        updateRowPreview(row);
      };

      const rebuildFileRows = () => {
        rows = [];
        filesList.replaceChildren();
        const list = fileInput.files ? [...fileInput.files] : [];
        if (!list.length) {
          fileLabel.textContent = 'Ningún archivo seleccionado';
          return;
        }
        fileLabel.textContent = list.length === 1
          ? (list[0].name + ' (' + (formatBytes?.(list[0].size) || list[0].size + ' B') + ')')
          : (list.length + ' archivos seleccionados');
        const chName = currentChannelName();
        const seriesHint = seriesInp.value.trim() || ctxSeries;
        const parsedList = list.map((f) => parseUploadBase(f.name, chName, seriesHint));
        // Serie global: contexto de navegación gana; si no, la más frecuente en nombres
        if (ctxSeries) {
          seriesInp.value = ctxSeries;
        } else if (!seriesInp.value.trim()) {
          const seriesCounts = {};
          for (const p of parsedList) {
            const s = p.series || '';
            if (s) seriesCounts[s] = (seriesCounts[s] || 0) + 1;
          }
          let bestSeries = '';
          let bestN = 0;
          for (const [s, n] of Object.entries(seriesCounts)) {
            if (n > bestN) { bestSeries = s; bestN = n; }
          }
          // Canal de una sola serie tipo "BRSRKR #01": series = canal si el parseo la dejó igual o vacía
          if (bestSeries) seriesInp.value = bestSeries;
          else if (chName) seriesInp.value = chName;
        }
        // Re-parsear con la serie global definitiva (mejor número/título)
        const seriesFinal = seriesInp.value.trim();
        const finalParsed = list.map((f) => parseUploadBase(f.name, chName, seriesFinal));
        for (let i = 0; i < list.length; i++) {
          addFileRow(list[i], finalParsed[i]);
        }
      };

      fileBtn.onclick = () => fileInput.click();
      fileInput.onchange = () => rebuildFileRows();

      editorialSel.onchange = () => {
        editorialInp.hidden = editorialSel.value !== '__new__';
        rebuildChannels();
      };
      editorialInp.oninput = () => { if (editorialSel.value === '__new__') rebuildChannels(); else updateAllPreviews(); };
      channelSel.onchange = () => {
        channelInp.hidden = channelSel.value !== '__new__';
        updateAllPreviews();
      };
      channelInp.oninput = () => updateAllPreviews();
      seriesInp.oninput = () => updateAllPreviews();
      includeChChk.onchange = () => updateAllPreviews();
      asWebpChk.onchange = () => {
        webpOptsBox.hidden = !asWebpChk.checked;
        updateAllPreviews();
      };
      resizeCb.onchange = () => updateAllPreviews(); // [2400px] visible en la propuesta si está marcado

      const status = el('p', 'sync-status', '');
      const actions = el('div', 'edit-actions');
      const cancel = el('button', 'btn', 'Cancelar');
      const goBtn = el('button', 'btn edit-save', 'Subir');
      cancel.onclick = () => { frame.remove(); };

      goBtn.onclick = async () => {
        if (busy) {
          await uiAlert('Ya hay una subida en curso');
          return;
        }
        if (!rows.length) {
          await uiAlert('Selecciona al menos un archivo');
          return;
        }
        const ed = editorialSel.value === '__new__' ? editorialInp.value.trim() : editorialSel.value;
        const chName = currentChannelName();
        if (!ed) { await uiAlert('Indica la editorial'); return; }
        if (!chName) { await uiAlert('Indica el canal'); return; }

        const wantWebp = !!asWebpChk.checked;
        const webpOpts = {
          quality: parseFloat(String(qualityInp.value).replace(',', '.')) || 0.40,
          resize: !!resizeCb.checked,
          maxEdge: 2400,
        };

        const jobs = rows.map((row) => {
          let outName = String(row.nameInp.value || '').trim();
          if (!outName || !row.nameTouched) {
            outName = composeFileName({
              channel: includeChChk.checked ? chName : '',
              series: seriesInp.value,
              number: row.numberInp.value,
              info: row.infoInp.value,
              asWebp: wantWebp,
              resize: !!webpOpts.resize,
            });
          } else {
            outName = ensureCbzName(outName, wantWebp, !!webpOpts.resize);
          }
          // Etiquetas de calidad: [2400px] (si se redimensiona) y después [WebP]
          if (wantWebp) outName = withQualityTags(outName, { webp: true, resize: !!webpOpts.resize });
          // Siempre: "Nombre de archivo"; ficha completa si el check del archivo está activo
          let caption = row.fichaChk?.checked
            ? buildComicCaption({
                fileName: outName,
                titleEs: row.titleEsInp?.value || '',
                originalTitle: row.origInp?.value || row.titleEsInp?.value || '',
                series: row.capSeriesInp?.value || seriesInp.value,
                writer: row.writerInp?.value || '',
                artist: row.artistInp?.value || '',
                publisher: row.pubInp?.value || ed,
                date: row.dateInp?.value || '',
                description: row.descInp?.value || '',
              })
            : buildComicCaption({ fileName: outName });
          // Ajustar al límite de Telegram (1024) antes de encolar
          caption = fitTelegramCaption(caption, 1024);
          return { file: row.file, outName, caption };
        });

        // Aviso si el canal ya tiene una copia con la misma calidad (mismo nombre base y etiquetas)
        try {
          const chOpt = [...channelSel.options].find((o) => o.value === channelSel.value);
          const chObj = chOpt?._ch;
          if (chObj?.id != null) {
            const existing = flattenVersions((await kv.get('f:' + chObj.id)) || []);
            const dups = jobs
              .map((j) => ({ j, hit: existingCopy(existing, j.outName) }))
              .filter((x) => x.hit);
            if (dups.length) {
              const msgDup = 'Ya existe en el canal una copia con esa calidad:\n\n'
                + dups.map((x) => `· ${x.j.outName}  (${QUALITY_LABEL[parseQuality(x.j.outName).q]})`).join('\n')
                + '\n\n¿Subir de todas formas?';
              if (!(await uiConfirm(msgDup))) return;
            }
          }
        } catch (e) { console.warn('[upload] comprobación de duplicados', e); }
        const summary = jobs.length === 1
          ? `¿Subir como «${jobs[0].outName}» al canal «${chName}» (${ed})?`
          : `¿Subir ${jobs.length} cómics al canal «${chName}» (${ed})?\n\n` + jobs.map((j) => '· ' + j.outName).join('\n');
        if (!(await uiConfirm(summary))) return;

        frame.remove();
        showUploadProgressPanel();

        const postErrorPlaceholder = async (ch, fileName, errMsg) => {
          if (!ch) return;
          try {
            await getReady();
            const client = getClient();
            const peer = peerOf(ch);
            const name = String(fileName || 'archivo.cbz').trim() || 'archivo.cbz';
            const detail = String(errMsg || 'error desconocido').slice(0, 800);
            const text =
              '⚠️ Fallo al subir «' + name + '»\n' +
              detail + '\n\n' +
              'Sube el archivo manualmente en este canal para mantener el orden.';
            await client.sendMessage(peer, { message: text });
          } catch (e) {
            console.warn('[upload] no se pudo dejar aviso en el canal', e);
          }
        };

        // Encolar un trabajo por archivo (misma serie / canal)
        for (const job of jobs) {
          const fileRef = job.file;
          const outName = job.outName;
          const captionText = job.caption || buildComicCaption({ fileName: outName });
          const runOne = async (ctx) => {
            let ch = null;
            const st = (msg) => {
              try { ctx.log(msg); } catch (_) {}
              try { logLine(msg); } catch (_) {}
              const s = String(msg || '');
              if (/Empaquetando|WebP|Extrayendo/i.test(s)) {
                try { ctx.setProgress?.(45); } catch (_) {}
              }
              const m = s.match(/(\d{1,3})\s*%\s*$/);
              if (m) {
                const pct = Number(m[1]) || 0;
                if (/Subiendo/i.test(s)) try { ctx.setProgress?.(70 + Math.round(pct * 0.25)); } catch (_) {}
                else if (/Descargando|Leyendo/i.test(s)) try { ctx.setProgress?.(15 + Math.round(pct * 0.2)); } catch (_) {}
              }
            };
            try {
              abort = false;
              // Stop de la cola: abortar descompresión / subida en curso
              ctx.onAbort?.(() => { abort = true; });
              st('[' + outName + '] Preparando canal…');
              ctx.setProgress(10);
              await yieldTick();
              await ctx.waitWhilePaused?.();
              if (ctx.isAborted?.()) throw Object.assign(new Error('cancelado'), { cancelled: true });
              ch = await ensureChannel(chName, ed, st);
              ctx.setProgress(20);
              st('[' + outName + '] ' + (wantWebp ? 'Convirtiendo a CBZ WebP…' : 'Convirtiendo a CBZ si hace falta…'));
              await yieldTick();
              let blob = await localFileToCbzBlob(fileRef, st, { asWebp: wantWebp, webpOpts });
              ctx.setProgress(55);
              st('[' + outName + '] Preparando subida… (' + (formatBytes?.(blob.size) || blob.size) + ')');
              await yieldTick();
              await ctx.waitWhilePaused?.();
              if (ctx.isAborted?.()) throw Object.assign(new Error('cancelado'), { cancelled: true });
              st('[' + outName + '] Subiendo…');
              ctx.setProgress(70);
              // uploadCbz(ch, fileName, blob, caption, status)
              await uploadCbz(ch, outName, blob, captionText, st);
              ctx.setProgress(100);
              st('[' + outName + '] Listo');
              // Actualizar caché del canal y refrescar la vista actual si es ese canal/serie
              try {
                await fetchFiles(ch);
              } catch (_) {}
              try {
                if (typeof onUploadDone === 'function') {
                  await onUploadDone(ch, { outName, outNames: [outName] });
                }
              } catch (e) {
                console.warn('[upload] onUploadDone', e);
              }
            } catch (e) {
              if (e?.cancelled) {
                st('[' + outName + '] Cancelado');
                throw e;
              }
              const errMsg = e?.message || String(e);
              st('[' + outName + '] ERROR: ' + errMsg);
              try { await postErrorPlaceholder(ch, outName, errMsg); } catch (_) {}
              throw e;
            }
          };

          if (jobQueue && typeof jobQueue.enqueue === 'function') {
            jobQueue.enqueue({
              id: 'upload:' + outName + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6),
              label: outName,
              run: runOne,
            });
          } else {
            // Fallback secuencial sin cola
            busy = true;
            try {
              await runOne({
                log: logLine,
                setProgress: () => {},
                waitWhilePaused: async () => {},
                isAborted: () => abort,
              });
            } catch (e) {
              if (!e?.cancelled) console.error('[upload]', e);
            } finally {
              busy = false;
              syncFloatingUi();
            }
          }
        }
        syncFloatingUi();
      };

      body.append(el('div', 'info-sec', 'Archivos'));
      body.append(fileBtn, fileInput, fileLabel);
      body.append(el('div', 'info-sec', 'Editorial'));
      body.append(editorialSel, editorialInp);
      body.append(el('div', 'info-sec', 'Canal'));
      body.append(channelSel, channelInp);
      body.append(el('div', 'info-sec', 'Serie'));
      body.append(seriesLab, seriesHint, seriesInp);
      body.append(includeChRow);
      body.append(filesSec, filesHint, filesList);
      body.append(webpRow, webpOptsBox);
      body.append(status);
      actions.append(cancel, goBtn);
      body.append(actions);
      box.append(head, body);
      frame.append(box);

      // Prefijar editorial / canal / serie desde el contexto de navegación
      if (ctxEditorial) {
        const hasEd = [...editorialSel.options].some((o) => o.value === ctxEditorial);
        if (hasEd) {
          editorialSel.value = ctxEditorial;
          editorialInp.hidden = true;
        } else {
          editorialSel.value = '__new__';
          editorialInp.hidden = false;
          editorialInp.value = ctxEditorial;
        }
      }
      rebuildChannels();
      if (ctxChannel) {
        const id = ctxChannel.id != null ? String(ctxChannel.id) : '';
        const byId = id && [...channelSel.options].find((o) => o.value === id);
        if (byId) {
          channelSel.value = id;
          channelInp.hidden = true;
        } else if (ctxChannel.name) {
          const byName = [...channelSel.options].find(
            (o) => (o._ch?.name || o.textContent || '').toLowerCase() === String(ctxChannel.name).toLowerCase()
          );
          if (byName) {
            channelSel.value = byName.value;
            channelInp.hidden = true;
          } else {
            channelSel.value = '__new__';
            channelInp.hidden = false;
            channelInp.value = ctxChannel.name;
          }
        }
      }
      if (ctxSeries) seriesInp.value = ctxSeries;
      updateAllPreviews();
      document.body.append(frame);
    } catch (e) {
      console.error('[upload] showUploadFrame', e);
      uiAlert('No se pudo abrir el formulario de subida: ' + (e?.message || e));
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
