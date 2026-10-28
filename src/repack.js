/**
 * Herramienta: convertir CBR → CBZ y re-subir (también mensajes reenviados).
 * Móvil: poca RAM, un archivo a la vez, liberar buffers.
 */
import * as zip from '@zip.js/zip.js';
import { fitTelegramCaption } from './caption.js';
import { withQualityTags, existingCopy, flattenVersions, sourceNameOf, parseQuality, QUALITY_LABEL } from './quality.js';

export function createRepackTool(d) {
  const {
    el, Api,
    kv, peerOf,
    fetchFiles, getMsg,
    downloadRarBytes, sniff, TgReader,
    natural, formatBytes,
    getIsHome,
    parseComicName, comicDisplay, comicDisplayName,
    seriesDisplayName, getComicSeriesOverride,
    parseComicCaption, buildComicCaption,
    onUploadDone,
  } = d;
  const getClient = () => d.client;
  const getReady = () => d.ready;
  const getLIB = () => d.LIB;
  // Importante: si no se declara, `jobQueue` lanza ReferenceError y la recarga "no hace nada"
  const jobQueue = d.jobQueue || null;

  let running = false;
  let abort = false;

  const isCbrName = (name) => /\.cbr$/i.test(name || '');
  const toCbzName = (name) => String(name || 'comic.cbr').replace(/\.cbr$/i, '.cbz');
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));
  /** Nombre sin extensión, para detectar la misma página en JPG+PNG etc. */
  const pageStem = (name) => String(name || '').replace(/\.[^.]+$/i, '').toLowerCase();
  /** Preferir más bytes; a igualdad, PNG/WebP > JPEG. */
  const pageQualityScore = (fileName, byteSize) => {
    const ext = (String(fileName).match(/\.([^.]+)$/i) || [,''])[1].toLowerCase();
    const extScore = ({ png: 4, tif: 4, tiff: 4, webp: 3, avif: 3, jpg: 1, jpeg: 1, gif: 0 })[ext] || 0;
    return (Number(byteSize) || 0) * 10 + extScore;
  };
  /** Evita colisión residual en el ZIP de salida. */
  const uniqueZipName = (used, name) => {
    let n = String(name || 'page.webp').replace(/^[/\\]+/, '');
    if (!n) n = 'page.webp';
    const key0 = n.toLowerCase();
    if (!used.has(key0)) { used.add(key0); return n; }
    const m = n.match(/^(.*)(\.[^.]+)$/);
    const stem = m ? m[1] : n;
    const ext = m ? m[2] : '';
    let i = 2;
    let cand;
    do { cand = `${stem}_${i}${ext}`; i++; } while (used.has(cand.toLowerCase()));
    used.add(cand.toLowerCase());
    return cand;
  };
  const isGramNoise = (e) => /Missing MTProto Entity|TL definition for ID 0/i.test(String(e?.message || e || ''));
  /** GramJS a veces lanza un error de parseo DESPUÉS de enviar: el mensaje ya está en Telegram, no reintentar (duplicaría la subida). */
  async function sendFileSafe(client, peer, opts) {
    try {
      return await client.sendFile(peer, opts);
    } catch (e) {
      if (isGramNoise(e)) {
        console.warn('[repack] aviso interno GramJS tras enviar (mensaje enviado):', e?.message || e);
        return null;
      }
      throw e;
    }
  }
  const askAlert = (m) => (typeof window.appAlert === 'function'
    ? window.appAlert(String(m || ''))
    : Promise.resolve(alert(String(m || ''))));
  const askConfirm = (m) => (typeof window.appConfirm === 'function'
    ? window.appConfirm(String(m || ''))
    : Promise.resolve(confirm(String(m || ''))));
  /** Copias que ya existen con la misma calidad que el nombre de salida (avisar antes de duplicar). */
  const findDuplicates = (entries) => {
    const out = [];
    for (const { f, outName } of entries) {
      const hit = existingCopy(flattenVersions([f]), outName);
      if (hit) out.push({ outName, q: parseQuality(outName).q, hit });
    }
    return out;
  };
  const dupMessage = (dups) => 'Ya existe una copia con esa calidad:\n\n'
    + dups.map((x) => `· ${x.outName}  (${QUALITY_LABEL[x.q]})`).join('\n')
    + '\n\n¿Subir de todas formas?';

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
  function ensureChannelInName(name, chName) {
    let n = cleanFileBase(String(name || '').replace(/\.cbz$/i, ''));
    if (!chName) return n + '.cbz';
    const low = n.toLowerCase();
    const chLow = chName.toLowerCase();
    // Ya incluye el canal: "Killadelphia #01", "Killadelphia - …", "Killadelphia"
    if (
      low === chLow
      || low.startsWith(chLow + ' #')
      || low.startsWith(chLow + ' -')
      || low.startsWith(chLow + '-')
      || low.startsWith(chLow + ' ')
    ) {
      return n + '.cbz';
    }
    // Si el título empieza por #n, prefijo "Canal #…" sin guión extra
    if (/^#\s*\S/.test(n)) {
      return chName + ' ' + n + '.cbz';
    }
    return chName + ' - ' + n + '.cbz';
  }

  function stripChannelFromName(name, chName) {
    let n = cleanFileBase(String(name || '').replace(/\.cbz$/i, ''));
    if (chName) {
      const low = n.toLowerCase();
      const chLow = chName.toLowerCase();
      if (low.startsWith(chLow)) {
        n = n.slice(chName.length).replace(/^\s*-\s*/, '').trim();
      }
    }
    return n + '.cbz';
  }

  const SPECIAL_RE = /\b(especial|special|extra|anual|annual|one[\s-]?shot|prólogo|prologo|epílogo|epilogo|spin[\s-]?off)\b(?:\s*#?\s*(\d+))?/i;

  /** "[serie] #[número/especial/extra…]" (sin título). Devuelve '' si no se puede formar. */
  function formattedBaseName(ch, f) {
    const raw = f?.name || 'comic.cbr';
    const cleaned = cleanFileBase(raw);
    const chName = (ch?.name || '').trim();
    let parsed = null;
    try {
      if (typeof parseComicName === 'function') {
        parsed = parseComicName(cleaned + '.cbz', chName) || parseComicName(raw, chName);
      }
    } catch (_) {}
    let series = '';
    try {
      if (typeof getComicSeriesOverride === 'function') {
        const ov = getComicSeriesOverride(ch, f);
        if (ov && String(ov).trim()) series = String(ov).trim();
      }
    } catch (_) {}
    if (!series && parsed?.series) series = String(parsed.series).trim();
    try {
      if (series && typeof seriesDisplayName === 'function') {
        const shown = seriesDisplayName(ch, series);
        if (shown && String(shown).trim()) series = String(shown).trim();
      }
    } catch (_) {}
    let num = parsed?.number != null ? String(parsed.number).replace(/^#\s*/, '').trim() : '';
    if (!num) {
      const hay = [parsed?.info, cleaned].filter(Boolean).join(' ');
      const m = hay.match(SPECIAL_RE);
      if (m) {
        const w = m[1].replace(/\s+/g, ' ');
        num = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() + (m[2] ? ' ' + m[2] : '');
      }
    }
    return series && num ? `${series} #${num}` : '';
  }

  function suggestUploadName(ch, f, includeChannel = true, formatted = false) {
    const raw = f?.name || 'comic.cbr';
    const cleaned = cleanFileBase(raw);
    const chName = (ch?.name || '').trim();

    // 0) Nombres formateados: "serie #número" (si no hay datos suficientes, se usa el nombre de siempre)
    if (formatted) {
      const fb = formattedBaseName(ch, f);
      if (fb) return includeChannel ? ensureChannelInName(fb, chName) : stripChannelFromName(fb, chName);
    }

    // 1) Título de cómic editado a mano (prioridad total sobre el parseo)
    try {
      if (typeof comicDisplayName === 'function') {
        const custom = comicDisplayName(ch, f, '');
        if (custom && String(custom).trim()) {
          const base = cleanFileBase(custom);
          return includeChannel ? ensureChannelInName(base, chName) : stripChannelFromName(base, chName);
        }
      }
    } catch (_) {}

    // 2) Serie efectiva: override manual o parseo del nombre
    let parsed = null;
    try {
      if (typeof parseComicName === 'function') {
        parsed = parseComicName(cleaned + '.cbz', chName) || parseComicName(raw, chName);
      }
    } catch (_) {}

    let seriesRaw = '';
    try {
      if (typeof getComicSeriesOverride === 'function') {
        const ov = getComicSeriesOverride(ch, f);
        if (ov && String(ov).trim()) seriesRaw = String(ov).trim();
      }
    } catch (_) {}
    if (!seriesRaw && parsed?.series) seriesRaw = String(parsed.series).trim();

    // Aplicar renombre de serie si existe
    let series = seriesRaw;
    try {
      if (series && typeof seriesDisplayName === 'function') {
        const shown = seriesDisplayName(ch, seriesRaw);
        if (shown && String(shown).trim()) series = String(shown).trim();
      }
    } catch (_) {}

    const num = parsed?.number != null && String(parsed.number).length
      ? String(parsed.number).trim()
      : '';
    const info = String(parsed?.info || '').trim();

    let base = '';
    if (series && num) {
      base = info ? (series + ' #' + num + ' - ' + info) : (series + ' #' + num);
    } else if (series) {
      base = info ? (series + ' - ' + info) : series;
    } else {
      // Fallback listado / nombre limpio
      try {
        if (typeof comicDisplay === 'function') {
          const d = comicDisplay(raw, chName);
          if (d && String(d).trim()) base = cleanFileBase(d);
        }
      } catch (_) {}
      if (!base) base = cleaned;
    }

    if (includeChannel) return ensureChannelInName(base, chName);
    return stripChannelFromName(base, chName);
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
    const webpOpts = (opts && opts.webpOpts) || {};
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
      // 1) Listar páginas; si hay misma base con distinta extensión, quedarnos con la de más calidad
      const candidates = [];
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
        candidates.push({
          base,
          stem: pageStem(base),
          size: copy.byteLength,
          blob: new Blob([copy.buffer], { type: mimeOf(base) }),
        });
      }
      const bestByStem = new Map();
      for (const c of candidates) {
        const prev = bestByStem.get(c.stem);
        if (!prev || pageQualityScore(c.base, c.size) > pageQualityScore(prev.base, prev.size)) {
          bestByStem.set(c.stem, c);
        }
      }
      const picked = [...bestByStem.values()];
      if (candidates.length > picked.length) {
        status(`Omitidas ${candidates.length - picked.length} página(s) duplicada(s) (misma base, peor calidad)`);
      }

      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
        bufferedWrite: true,
        level: 0,
      });
      const usedNames = new Set();
      let nImg = 0;
      for (const c of picked) {
        if (abort) {
          try { await writer.close(); } catch (_) {}
          throw Object.assign(new Error('cancelado'), { cancelled: true });
        }
        let pageBlob = c.blob;
        let outName = c.base;
        if (wantWebp) {
          const origSize = pageBlob.size || 0;
          const converted = await blobToWebp(pageBlob, webpOpts);
          if (converted && converted.size && converted.size < origSize * 0.98) {
            pageBlob = converted;
            outName = c.base.replace(/\.[^.]+$/i, '.webp');
          }
        }
        outName = uniqueZipName(usedNames, outName);
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
      // 1) Cargar páginas y, si hay 001h.jpg + 001h.png, quedarnos solo con la de mejor calidad
      const candidates = [];
      for (const e of entries) {
        if (abort) {
          try { await reader.close(); } catch (_) {}
          throw Object.assign(new Error('cancelado'), { cancelled: true });
        }
        if (e.directory) continue;
        const base = (e.filename || '').split(/[/\\]/).pop() || e.filename;
        if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) continue;
        const pageBlob = await e.getData(new zip.BlobWriter());
        if (!pageBlob || !pageBlob.size) continue;
        candidates.push({
          base,
          stem: pageStem(base),
          size: pageBlob.size || 0,
          blob: pageBlob,
        });
      }
      try { await reader.close(); } catch (_) {}

      const bestByStem = new Map();
      for (const c of candidates) {
        const prev = bestByStem.get(c.stem);
        if (!prev || pageQualityScore(c.base, c.size) > pageQualityScore(prev.base, prev.size)) {
          bestByStem.set(c.stem, c);
        }
      }
      const picked = [...bestByStem.values()];
      if (candidates.length > picked.length) {
        status(`Omitidas ${candidates.length - picked.length} página(s) duplicada(s) (misma base, peor calidad)`);
      }

      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
        bufferedWrite: true,
        level: 0,
      });
      const usedNames = new Set();
      let nImg = 0;
      for (const c of picked) {
        if (abort) {
          try { await writer.close(); } catch (_) {}
          throw Object.assign(new Error('cancelado'), { cancelled: true });
        }
        let pageBlob = c.blob;
        let outName = c.base;
        if (wantWebp) {
          const origSize = pageBlob.size || 0;
          const converted = await blobToWebp(pageBlob, webpOpts);
          if (converted && converted.size && converted.size < origSize * 0.98) {
            pageBlob = converted;
            outName = c.base.replace(/\.[^.]+$/i, '.webp');
          }
        }
        outName = uniqueZipName(usedNames, outName);
        nImg++;
        await writer.add(outName, new zip.BlobReader(pageBlob), { level: 0 });
        pageBlob = null;
        status(`Empaquetando… ${nImg} img` + (wantWebp ? ' (WebP)' : ''));
        await yieldTick();
        if (nImg % 3 === 0) await new Promise((r) => setTimeout(r, 30));
      }
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
      await sendFileSafe(client, peer, {
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
      await sendFileSafe(client, peer, {
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
      await sendFileSafe(client, peer, {
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

  /** Serie efectiva de un archivo (override manual o parseo del nombre, con renombre). */
  function candidateSeries(ch, f) {
    let raw = '';
    try {
      const ov = typeof getComicSeriesOverride === 'function' ? getComicSeriesOverride(ch, f) : '';
      if (ov && String(ov).trim()) raw = String(ov).trim();
    } catch (_) {}
    if (!raw) {
      try {
        const p = typeof parseComicName === 'function' ? parseComicName(f.name || '', ch.name) : null;
        if (p?.series) raw = String(p.series).trim();
      } catch (_) {}
    }
    if (!raw) return '';
    try {
      const shown = typeof seriesDisplayName === 'function' ? seriesDisplayName(ch, raw) : '';
      if (shown && String(shown).trim()) return String(shown).trim();
    } catch (_) {}
    return raw;
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
          series: candidateSeries(ch, f),
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

  /** Aviso en el canal de Telegram para poder subir a mano en el mismo sitio */
  async function postErrorPlaceholder(ch, fileName, errMsg) {
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
      console.warn('[repack] no se pudo dejar aviso en el canal', e);
    }
  }

  async function processOne(item, deleteOriginal, asWebp = false, onStatus, webpOpts = {}, onProgress) {
    const { ch, f } = item;
    const label = f.name || ('#' + f.id);
    const status = (t) => {
      const msg = '[' + label + '] ' + t;
      try { logLine(msg); } catch (_) {}
      try { onStatus?.(msg); } catch (_) {}
    };
    const prog = (p) => { try { onProgress?.(p); } catch (_) {} };

    status(`Inicio (${formatBytes?.(f.size) || f.size + ' B'})`);
    prog(5);
    if (f.size > 40 * 1024 * 1024) {
      status('AVISO: archivo grande; en móvil puede fallar por memoria');
    }
    let cbz = null;
    let outName = item.outName || toCbzName(cleanFileBase(f.name) + '.cbr');
    try {
      const useWebp = !!(item && item.asWebp) || !!asWebp;
      const wOpts = (item && item.webpOpts) || webpOpts || {};
      prog(10);
      const statusWithProg = (t) => {
        status(t);
        // Estimar avance por fase a partir del texto
        const s = String(t || '');
        if (/Descargando/i.test(s)) {
          const m = s.match(/(\d{1,3})\s*%/);
          prog(m ? 10 + Math.round((Number(m[1]) || 0) * 0.35) : 20);
        } else if (/Extrayendo|Empaquetando|WebP|Reempaquetando/i.test(s)) {
          prog(50);
        } else if (/Subiendo/i.test(s)) {
          const m = s.match(/(\d{1,3})\s*%/);
          prog(m ? 70 + Math.round((Number(m[1]) || 0) * 0.25) : 75);
        } else if (/Preparando subida/i.test(s)) {
          prog(68);
        }
      };
      cbz = await convertToCbzBlob(ch, f, statusWithProg, { asWebp: useWebp, webpOpts: wOpts });
      if (abort) throw Object.assign(new Error('cancelado'), { cancelled: true });
      // Si no hay outName explícito y es WebP: conservar nombre del original + [WebP]
      // (evita "Canal - #01" que crea una serie distinta "Canal -")
      if (useWebp && !item.outName) {
        outName = String(sourceNameOf(f) || 'comic.cbr')
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\.cb[zr]$/i, '.cbz');
        if (!/\.cbz$/i.test(outName)) outName += '.cbz';
      } else {
        outName = String(outName).trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
        if (!/\.cbz$/i.test(outName)) outName = outName.replace(/\.cb[zr]$/i, '') + '.cbz';
      }
      // Etiquetas de calidad: [2400px] (si se redimensiona) y después [WebP]
      if (useWebp) outName = withQualityTags(outName, { webp: true, resize: wOpts.resize !== false });
      status(`Nombre de subida: ${outName}`);
      prog(65);
      // Caption del original + Nombre de archivo = nombre final (WebP u otro)
      let caption = String(item.caption || f.caption || '').trim();
      if (!caption && typeof getMsg === 'function') {
        try {
          const msg = await getMsg(ch, f);
          caption = String(msg?.message || '').trim();
        } catch (e) {
          console.warn('[repack] no se pudo leer caption del original', e);
        }
      }
      if (caption && typeof parseComicCaption === 'function' && typeof buildComicCaption === 'function') {
        try {
          const fields = parseComicCaption(caption);
          fields.fileName = outName;
          caption = buildComicCaption(fields);
          if (fields.description && !/Descripción:/i.test(caption)) {
            caption = caption + '\nDescripción: ' + fields.description;
          }
        } catch (e) {
          console.warn('[repack] caption rebuild', e);
        }
      }
      if (!caption || !String(caption).trim()) {
        caption = typeof buildComicCaption === 'function'
          ? buildComicCaption({ fileName: outName })
          : ('Nombre de archivo: ' + outName);
      } else if (typeof parseComicCaption === 'function' && typeof buildComicCaption === 'function') {
        try {
          const fields = parseComicCaption(caption);
          if (!fields.fileName) {
            fields.fileName = outName;
            caption = buildComicCaption(fields);
          }
        } catch (_) {}
      }
      // Límite Telegram 1024: la Descripción siempre se sube; si no cabe se recorta por palabras con "..."
      {
        const fitted = fitTelegramCaption(caption, 1024);
        if (fitted.length < String(caption || '').length) {
          status(`Caption ajustado a ${fitted.length}/1024 caracteres (Descripción recortada con "...")`);
        }
        caption = fitted;
      }
      status(caption ? ('Caption: ' + caption.length + ' caracteres') : 'Sin caption');
      try {
        await uploadCbz(ch, outName, cbz, caption, statusWithProg);
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (/Missing MTProto Entity/i.test(msg) || /TL definition for ID 0/i.test(msg)) {
          console.warn('[repack] aviso GramJS tras subida (se ignora):', msg);
          status('✓ Subido (aviso interno GramJS ignorado)');
        } else {
          throw e;
        }
      }
      cbz = null;
      status('Subido a Telegram');
      prog(95);
      if (deleteOriginal) {
        status('Borrando original…');
        await deleteMessage(ch, f.id);
        status('Original borrado');
      }
      try { await fetchFiles(ch); } catch (_) {}
      try {
        if (typeof onUploadDone === 'function') {
          await onUploadDone(ch, { outName, outNames: [outName] });
        }
      } catch (e) {
        console.warn('[repack] onUploadDone', e);
      }
      prog(100);
    } catch (e) {
      if (!e?.cancelled && !abort) {
        status('ERROR: ' + (e?.message || e));
        await postErrorPlaceholder(ch, outName || f.name, e?.message || e);
      }
      throw e;
    } finally {
      cbz = null;
    }
  }

  async function runQueue(selected, deleteOriginal, asWebp = false, webpOpts = {}) {
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
      const onStatus = (m) => {
        try { ctx?.log?.(m); } catch (_) {}
      };
      const onProgress = (p) => {
        try { ctx?.setProgress?.(p); } catch (_) {}
      };
      // Stop de la cola: abortar descarga / descompresión / subida en curso
      abort = false;
      ctx?.onAbort?.(() => { abort = true; });
      await processOne({ ...item, asWebp, webpOpts }, deleteOriginal, asWebp, onStatus, webpOpts, onProgress);
    };

    if (jobQueue && typeof jobQueue.enqueue === 'function' && selected.length) {
      try {
        for (const item of selected) {
          jobQueue.enqueue({
            type: 'repack',
            label: item.outName || item.f?.name || 'repack',
            run: async (ctx) => {
              await work(item, ctx);
              try { ctx.setProgress(100); } catch (_) {}
            },
          });
        }
        try { jobQueue.show(); } catch (_) {}
      } catch (e) {
        console.error('[repack] jobQueue', e);
        alert('No se pudo encolar: ' + (e?.message || e));
      }
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
        await processOne({ ...item, asWebp, webpOpts }, deleteOriginal, asWebp, null, webpOpts, setFill);
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
  function showNameReview(selected, deleteOriginal, asWebp = false, webpOpts = {}) {
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
    const rz = !!(webpOpts && webpOpts.resize !== false);
    if (asWebp) {
      body.append(el('p', 'cover-pick-hint', `WebP activado: se añadirá ${rz ? '[2400px][WebP]' : '[WebP]'} al nombre y las páginas se convertirán.`));
    }

    const includeChChk = el('input');
    includeChChk.type = 'checkbox';
    includeChChk.checked = true;
    const includeChRow = el('label', 'repack-check');
    includeChRow.append(includeChChk, document.createTextNode(' Incluir nombre del canal en los archivos'));
    body.append(includeChRow);

    // Nombres formateados: "serie #número/especial/extra…" (desmarcado = nombres completos como antes)
    const fmtChk = el('input');
    fmtChk.type = 'checkbox';
    fmtChk.checked = true;
    const fmtRow = el('label', 'repack-check');
    fmtRow.append(fmtChk, document.createTextNode(' Nombres formateados'));
    body.append(fmtRow);

    const inputs = [];
    const applyNames = () => {
      const withCh = !!includeChChk.checked;
      const fmt = !!fmtChk.checked;
      for (const inp of inputs) {
        if (inp._manual) continue;
        let name = suggestUploadName(inp._item.ch, inp._item.f, withCh, fmt);
        if (asWebp) name = withQualityTags(name, { webp: true, resize: rz });
        inp.value = name;
      }
    };

    for (const item of selected) {
      const suggested = suggestUploadName(item.ch, item.f, true, true);
      const row = el('div', 'repack-name-row');
      row.append(el('div', 'repack-name-from', item.f.name || ''));
      const inp = el('input', 'edit-input repack-name-input');
      inp.type = 'text';
      inp.value = asWebp ? withQualityTags(suggested, { webp: true, resize: rz }) : suggested;
      inp.autocomplete = 'off';
      inp._item = item;
      inp._manual = false;
      inp.oninput = () => { inp._manual = true; };
      inputs.push(inp);
      row.append(inp);
      row.append(el('small', '', item.ch.name || ''));
      body.append(row);
    }
    includeChChk.onchange = applyNames;
    fmtChk.onchange = applyNames;

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => frame.remove();
    const goBtn = el('button', 'btn edit-save', 'Subir');
    goBtn.onclick = async () => {
      const withCh = !!includeChChk.checked;
      const ready = inputs.map((inp) => {
        let name = String(inp.value || '').trim();
        if (!name) name = suggestUploadName(inp._item.ch, inp._item.f, withCh, !!fmtChk.checked);
        name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/\.cbz$/i.test(name)) name = name.replace(/\.cb[zr]$/i, '') + '.cbz';
        if (!/\.cbz$/i.test(name)) name += '.cbz';
        if (asWebp) name = withQualityTags(name, { webp: true, resize: rz });
        return { ...inp._item, outName: name, asWebp, webpOpts };
      });
      const dups = findDuplicates(ready.map((x) => ({ f: x.f, outName: x.outName })));
      if (dups.length && !(await askConfirm(dupMessage(dups)))) return;
      frame.remove();
      runQueue(ready, deleteOriginal, asWebp, webpOpts);
    };
    actions.append(cancel, goBtn);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    // Solo cierra con Cancelar / ×
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

    const webpOptsBox = el('div', 'webp-opts');
    webpOptsBox.hidden = true;
    const qualityLab = el('label', 'sync-label', 'Calidad');
    const qualityInp = el('input', 'edit-input');
    qualityInp.type = 'text';
    qualityInp.value = '0.40';
    qualityInp.placeholder = '0.40';
    const resizeRow = el('label', 'repack-check');
    const resizeCb = el('input');
    resizeCb.type = 'checkbox';
    resizeCb.checked = true;
    resizeRow.append(resizeCb, document.createTextNode(' Redimensionar (lado mayor máx. 2400 px)'));
    webpOptsBox.append(qualityLab, qualityInp, resizeRow);
    body.append(webpOptsBox);
    webpCb.onchange = () => { webpOptsBox.hidden = !webpCb.checked; };

    // Filtros editorial / canal
    const edSel = el('select', 'edit-input upload-select');
    const chSel = el('select', 'edit-input upload-select');
    chSel.hidden = true;
    const edLab = el('label', 'sync-label', 'Editorial');
    const chLab = el('label', 'sync-label', 'Canal');
    chLab.hidden = true;
    const seSel = el('select', 'edit-input upload-select');
    seSel.hidden = true;
    const seLab = el('label', 'sync-label', 'Serie');
    seLab.hidden = true;
    body.append(edLab, edSel, chLab, chSel, seLab, seSel);

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
    // Solo cierra con Cancelar / ×
    document.body.append(frame);

    let allCandidates = [];
    let candidates = [];
    const checks = [];

    const rebuildFilters = () => {
      const groups = [...new Set(allCandidates.map((x) => x.ch.group || 'Sin editorial'))].sort();
      edSel.replaceChildren();
      const oAll = el('option');
      oAll.value = '';
      oAll.textContent = 'Todas';
      edSel.append(oAll);
      for (const g of groups) {
        const o = el('option');
        o.value = g;
        o.textContent = g;
        edSel.append(o);
      }
      edSel.value = '';
      chSel.hidden = true;
      chLab.hidden = true;
      rebuildSeries();
      applyFilter();
    };

    const NO_SERIES = '\u0000none';
    const rebuildSeries = () => {
      const g = edSel.value;
      const cid = chSel.value;
      seSel.replaceChildren();
      const oAll = el('option');
      oAll.value = '';
      oAll.textContent = 'Todas';
      seSel.append(oAll);
      if (!g || !cid) {
        seSel.hidden = true;
        seLab.hidden = true;
        return;
      }
      const set = new Set();
      let none = false;
      for (const x of allCandidates) {
        if ((x.ch.group || 'Sin editorial') !== g || String(x.ch.id) !== cid) continue;
        if (x.series) set.add(x.series); else none = true;
      }
      for (const sName of [...set].sort((a, b) => String(a).localeCompare(String(b)))) {
        const o = el('option');
        o.value = sName;
        o.textContent = sName;
        seSel.append(o);
      }
      if (none) {
        const o = el('option');
        o.value = NO_SERIES;
        o.textContent = '(Sin serie)';
        seSel.append(o);
      }
      seSel.value = '';
      const show = set.size > 0 || none;
      seSel.hidden = !show;
      seLab.hidden = !show;
    };

    const rebuildChannels = () => {
      const g = edSel.value;
      chSel.replaceChildren();
      const oAll = el('option');
      oAll.value = '';
      oAll.textContent = 'Todos';
      chSel.append(oAll);
      if (!g) {
        chSel.hidden = true;
        chLab.hidden = true;
        return;
      }
      const chs = [...new Map(
        allCandidates
          .filter((x) => (x.ch.group || 'Sin editorial') === g)
          .map((x) => [String(x.ch.id), x.ch])
      ).values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      for (const c of chs) {
        const o = el('option');
        o.value = String(c.id);
        o.textContent = c.name;
        chSel.append(o);
      }
      chSel.value = '';
      chSel.hidden = false;
      chLab.hidden = false;
    };

    const applyFilter = () => {
      const g = edSel.value;
      const cid = chSel.value;
      candidates = allCandidates.filter((x) => {
        if (g && (x.ch.group || 'Sin editorial') !== g) return false;
        if (cid && String(x.ch.id) !== cid) return false;
        const sv = seSel.value;
        if (sv === NO_SERIES) { if (x.series) return false; }
        else if (sv && x.series !== sv) return false;
        return true;
      });
      paintList();
      status.textContent = candidates.length
        ? (candidates.length + ' candidato(s)')
        : (allCandidates.length ? 'Sin candidatos con este filtro' : 'Sin candidatos');
    };

    const paintList = () => {
      listHost.replaceChildren();
      checks.length = 0;
      if (!candidates.length) {
        listHost.append(el('p', 'cover-pick-hint',
          allCandidates.length
            ? 'Ningún archivo con el filtro actual.'
            : 'No hay CBR ni reenviados indexados. Entra antes en los canales.'
        ));
        btnStart.disabled = true;
        return;
      }
      for (const item of candidates) {
        const row = el('label', 'repack-row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = false; // ninguno por defecto
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

    edSel.onchange = () => {
      rebuildChannels();
      rebuildSeries();
      applyFilter();
    };
    chSel.onchange = () => {
      rebuildSeries();
      applyFilter();
    };
    seSel.onchange = applyFilter;

    btnAll.onclick = () => checks.forEach((c) => { c.checked = true; });
    btnNone.onclick = () => checks.forEach((c) => { c.checked = false; });
    btnStart.onclick = () => {
      const selected = checks.filter((c) => c.checked).map((c) => c._item);
      if (!selected.length) {
        alert('Selecciona al menos un archivo');
        return;
      }
      if (selected.length > 1 && !confirm(`Vas a procesar ${selected.length} archivos. ¿Seguro? Mejor de uno en uno en móvil.`)) return;
      const webpOpts = {
        quality: parseFloat(String(qualityInp.value).replace(',', '.')) || 0.40,
        resize: !!resizeCb.checked,
        maxEdge: 2400,
      };
      frame.remove();
      showNameReview(selected, delCb.checked, !!webpCb.checked, webpOpts);
    };
    collectCandidates().then((list) => {
      allCandidates = list;
      status.textContent = list.length ? `${list.length} candidato(s)` : 'Sin candidatos';
      rebuildFilters();
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

  /**
   * Formulario previo: Añadir versión WebP de un cómic ya en el canal.
   * Por defecto conserva el nombre original + [WebP] (no "Canal - #n").
   */
  function offerWebpVersion(ch, f) {
    if (!ch || !f) return;
    document.querySelector('.info-frame.webp-version')?.remove();
    const frame = el('div', 'info-frame webp-version');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Añadir versión WebP'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');

    body.append(el('p', 'cover-pick-hint',
      'Se descargará el archivo, se convertirán las páginas a WebP y se subirá una copia al mismo canal. Se conserva la ficha Telegram del original.'
    ));
    const srcRow = el('div', 'info-row');
    srcRow.append(el('span', 'info-label', 'Original'), el('span', 'info-value', f.name || ''));
    body.append(srcRow);
    const chRow = el('div', 'info-row');
    chRow.append(el('span', 'info-label', 'Canal'), el('span', 'info-value', ch.name || ''));
    body.append(chRow);

    const webpLock = el('label', 'repack-check');
    const webpCb = el('input');
    webpCb.type = 'checkbox';
    webpCb.checked = true;
    webpCb.disabled = true;
    webpLock.append(webpCb, document.createTextNode(' Convertir páginas a WebP (añade [WebP] al nombre)'));
    body.append(webpLock);

    const qualityLab = el('label', 'sync-label', 'Calidad WebP (0–1)');
    const qualityInp = el('input', 'edit-input');
    qualityInp.type = 'text';
    qualityInp.value = '0.40';
    qualityInp.placeholder = '0.40';
    body.append(qualityLab, qualityInp);

    const resizeRow = el('label', 'repack-check');
    const resizeCb = el('input');
    resizeCb.type = 'checkbox';
    resizeCb.checked = true;
    resizeRow.append(resizeCb, document.createTextNode(' Redimensionar (lado mayor máx. 2400 px)'));
    body.append(resizeRow);

    // Nombre por defecto = original + [WebP] (misma serie al agrupar)
    const originalName = () => {
      let n = String(sourceNameOf(f) || 'comic.cbz')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\.cb[zr]$/i, '.cbz');
      if (!/\.cbz$/i.test(n)) n += '.cbz';
      return withQualityTags(n, { webp: true, resize: !!resizeCb.checked });
    };

    const includeChChk = el('input');
    includeChChk.type = 'checkbox';
    includeChChk.checked = false; // por defecto NO reescribir con "Canal - …"
    const includeChRow = el('label', 'repack-check');
    includeChRow.append(includeChChk, document.createTextNode(' Reconstruir nombre (serie #n) desde datos del cómic'));
    body.append(includeChRow);

    body.append(el('label', 'sync-label', 'Nombre al subir'));
    const nameInp = el('input', 'edit-input');
    nameInp.type = 'text';
    nameInp.autocomplete = 'off';
    nameInp.value = originalName();
    body.append(nameInp);
    // Marcar/desmarcar "Redimensionar" actualiza [2400px] en la propuesta (respeta lo que hayas editado)
    resizeCb.onchange = () => {
      nameInp.value = withQualityTags(nameInp.value || originalName(), { webp: true, resize: !!resizeCb.checked });
    };

    includeChChk.onchange = () => {
      if (includeChChk.checked) {
        let n = suggestUploadName(ch, f, false); // sin forzar "Canal -"
        if (!/\.cbz$/i.test(n)) n = n.replace(/\.cb[zr]$/i, '') + '.cbz';
        nameInp.value = withQualityTags(n, { webp: true, resize: !!resizeCb.checked });
      } else {
        nameInp.value = originalName();
      }
    };

    const delRow = el('label', 'repack-check');
    const delCb = el('input');
    delCb.type = 'checkbox';
    delCb.checked = false;
    delRow.append(delCb, document.createTextNode(' Borrar el original tras subir OK'));
    body.append(delRow);

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => frame.remove();
    const goBtn = el('button', 'btn edit-save', 'Subir versión WebP');
    goBtn.onclick = async () => {
      let name = String(nameInp.value || '').trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
      if (!name) name = originalName();
      if (!/\.cbz$/i.test(name)) name = name.replace(/\.cb[zr]$/i, '') + '.cbz';
      if (!/\.cbz$/i.test(name)) name += '.cbz';
      name = withQualityTags(name, { webp: true, resize: !!resizeCb.checked });
      const dups = findDuplicates([{ f, outName: name }]);
      if (dups.length && !(await askConfirm(dupMessage(dups)))) return;
      const webpOpts = {
        quality: parseFloat(String(qualityInp.value).replace(',', '.')) || 0.40,
        resize: !!resizeCb.checked,
        maxEdge: 2400,
      };
      frame.remove();
      runQueue(
        [{ ch, f, outName: name, asWebp: true, webpOpts, caption: f.caption || '' }],
        !!delCb.checked,
        true,
        webpOpts
      );
    };
    actions.append(cancel, goBtn);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }

  /**
   * Añadir versión WebP a TODA una serie: Media ([WebP]) y/o Baja ([2400px][WebP]).
   * Una tarea por cómic y calidad en la Cola de tareas; las versiones que ya existen se omiten con aviso.
   */
  function offerWebpVersionSeries(ch, seriesLabel, files) {
    const list = (files || []).filter(Boolean);
    if (!ch || !list.length) return;
    document.querySelector('.info-frame.webp-version')?.remove();
    const frame = el('div', 'info-frame webp-version');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Añadir versión WebP'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');

    const shown = (() => { try { return seriesDisplayName(ch, seriesLabel) || seriesLabel; } catch (_) { return seriesLabel; } })();
    body.append(el('p', 'cover-pick-hint',
      `Serie «${shown}» · ${list.length} cómic(s). Se descargará cada cómic, se convertirán sus páginas a WebP y se subirá la copia al mismo canal (un trabajo por cómic en la Cola de tareas).`
    ));

    const mkRow = (title, text, checked) => {
      const row = el('label', 'repack-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      row.append(cb, document.createTextNode(' '), el('b', '', title), document.createTextNode(' - ' + text));
      body.append(row);
      return cb;
    };
    const midCb = mkRow('Media', 'convertir todos los cómics de la serie a WebP', true);
    const lowCb = mkRow('Baja', 'convertir todos los cómics de la serie a WebP y redimensionar las imágenes grandes a 2400px', false);

    body.append(el('label', 'sync-label', 'Calidad WebP (0–1)'));
    const qualityInp = el('input', 'edit-input');
    qualityInp.type = 'text';
    qualityInp.value = '0.40';
    qualityInp.placeholder = '0.40';
    body.append(qualityInp);

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => frame.remove();
    const goBtn = el('button', 'btn edit-save', 'Subir versiones WebP');
    goBtn.onclick = async () => {
      const targets = [];
      if (midCb.checked) targets.push({ key: 'mid', resize: false, label: 'Media' });
      if (lowCb.checked) targets.push({ key: 'low', resize: true, label: 'Baja' });
      if (!targets.length) { await askAlert('Selecciona al menos una calidad (Media o Baja).'); return; }
      let quality = parseFloat(String(qualityInp.value).replace(',', '.'));
      if (!(quality > 0 && quality <= 1)) quality = 0.40;

      const plans = { mid: [], low: [] };
      const skipped = [];
      for (const f of list) {
        for (const t of targets) {
          const outName = withQualityTags(sourceNameOf(f), { webp: true, resize: t.resize });
          if (existingCopy(flattenVersions([f]), outName)) {
            skipped.push(`· ${outName}  (${t.label})`);
            continue;
          }
          plans[t.key].push({
            ch, f, outName, asWebp: true,
            webpOpts: { quality, resize: t.resize, maxEdge: 2400 },
            caption: f.caption || '',
          });
        }
      }
      frame.remove();
      const todo = plans.mid.length + plans.low.length;
      if (skipped.length) {
        await askAlert(
          'Ya existen estas versiones y no se van a hacer:\n\n' + skipped.join('\n')
          + (todo ? `\n\nSe crearán las ${todo} restantes.` : '\n\nNo queda nada por crear.')
        );
      }
      for (const t of targets) {
        const items = plans[t.key];
        if (!items.length) continue;
        await runQueue(items, false, true, items[0].webpOpts);
      }
    };
    actions.append(cancel, goBtn);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }


  /**
   * Añadir versión WebP a TODOS los cómics de un canal (misma UI/lógica que serie).
   */
  function offerWebpVersionChannel(ch, files) {
    const list = (files || []).filter(Boolean);
    if (!ch || !list.length) {
      try {
        const m = 'No hay cómics en este canal.';
        if (typeof window.appAlert === 'function') window.appAlert(m);
        else alert(m);
      } catch (_) {}
      return;
    }
    document.querySelector('.info-frame.webp-version')?.remove();
    const frame = el('div', 'info-frame webp-version');
    const box = el('div', 'info-box');
    const head = el('div', 'info-head');
    head.append(el('span', '', 'Añadir versión WebP'));
    const close = el('button', 'btn info-close', '×');
    close.onclick = () => frame.remove();
    head.append(close);
    const body = el('div', 'info-body');

    const label = (ch.name || 'Canal');
    body.append(el('p', 'cover-pick-hint',
      `Canal «${label}» · ${list.length} cómic(s). Se descargará cada cómic, se convertirán sus páginas a WebP y se subirá la copia al mismo canal (un trabajo por cómic en la Cola de tareas).`
    ));

    const mkRow = (title, text, checked) => {
      const row = el('label', 'repack-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      row.append(cb, document.createTextNode(' '), el('b', '', title), document.createTextNode(' - ' + text));
      body.append(row);
      return cb;
    };
    const midCb = mkRow('Media', 'convertir todos los cómics del canal a WebP', true);
    const lowCb = mkRow('Baja', 'convertir todos los cómics del canal a WebP y redimensionar las imágenes grandes a 2400px', false);

    body.append(el('label', 'sync-label', 'Calidad WebP (0–1)'));
    const qualityInp = el('input', 'edit-input');
    qualityInp.type = 'text';
    qualityInp.value = '0.40';
    qualityInp.placeholder = '0.40';
    body.append(qualityInp);

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.onclick = () => frame.remove();
    const goBtn = el('button', 'btn edit-save', 'Subir versiones WebP');
    goBtn.onclick = async () => {
      const targets = [];
      if (midCb.checked) targets.push({ key: 'mid', resize: false, label: 'Media' });
      if (lowCb.checked) targets.push({ key: 'low', resize: true, label: 'Baja' });
      if (!targets.length) { await askAlert('Selecciona al menos una calidad (Media o Baja).'); return; }
      let quality = parseFloat(String(qualityInp.value).replace(',', '.'));
      if (!(quality > 0 && quality <= 1)) quality = 0.40;

      const plans = { mid: [], low: [] };
      const skipped = [];
      for (const f of list) {
        for (const t of targets) {
          const outName = withQualityTags(sourceNameOf(f), { webp: true, resize: t.resize });
          if (existingCopy(flattenVersions([f]), outName)) {
            skipped.push(`· ${outName}  (${t.label})`);
            continue;
          }
          plans[t.key].push({
            ch, f, outName, asWebp: true,
            webpOpts: { quality, resize: t.resize, maxEdge: 2400 },
            caption: f.caption || '',
          });
        }
      }
      frame.remove();
      const todo = plans.mid.length + plans.low.length;
      if (skipped.length) {
        await askAlert(
          'Ya existen estas versiones y no se van a hacer:\n\n' + skipped.join('\n')
          + (todo ? `\n\nSe crearán las ${todo} restantes.` : '\n\nNo queda nada por crear.')
        );
      }
      for (const t of targets) {
        const items = plans[t.key];
        if (!items.length) continue;
        await runQueue(items, false, true, items[0].webpOpts);
      }
    };
    actions.append(cancel, goBtn);
    body.append(actions);
    box.append(head, body);
    frame.append(box);
    document.body.append(frame);
  }

  return {
    offerWebpVersionSeries,
    offerWebpVersionChannel,
    showRepackFrame,
    isRunning: () => running,
    hideFloatingUi,
    syncFloatingUi,
    offerWebpVersion,
    suggestUploadName,
  };
}

