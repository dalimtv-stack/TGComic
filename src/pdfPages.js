/**
 * Lectura de PDF en el visor (solo raster → bitmap por página).
 * Decisiones de producto:
 * - Magic %PDF + extensión en UI
 * - PDF completo en memoria; raster bajo demanda
 * - Escala: pantalla × devicePixelRatio, tope 2400 (móvil) / 4096 (PC)
 * - Caché en RAM: 2 bitmaps; IndexedDB vía pageCache del caller
 * - Sin text/annotation layer; intent display; fondo transparente
 * - Zoom y modos sobre el bitmap (como CBZ)
 */
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const abortErr = () => Object.assign(new Error('cancelled'), { cancelled: true });

function isMobileLike() {
  try {
    if (typeof window === 'undefined') return true;
    if (window.matchMedia?.('(max-width: 900px)').matches) return true;
    if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  } catch (_) {}
  return false;
}

function maxEdgePx() {
  return isMobileLike() ? 2400 : 4096;
}

function screenLongPx() {
  try {
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    const w = Number(window.innerWidth) || 800;
    const h = Number(window.innerHeight) || 600;
    return Math.max(w, h) * dpr;
  } catch {
    return 1200;
  }
}

/** Escala para que el lado largo quede en min(tope, max(pantalla×dpr, 1)). */
function scaleForPage(page) {
  const base = page.getViewport({ scale: 1 });
  const long = Math.max(base.width, base.height) || 1;
  const target = Math.min(maxEdgePx(), Math.max(1, screenLongPx()));
  return Math.max(0.05, target / long);
}

function canvasToBlob(canvas, type = 'image/webp', quality = 0.92) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (b) => {
          if (b && b.size) return resolve(b);
          // Safari a veces falla WebP: fallback PNG
          try {
            canvas.toBlob((b2) => resolve(b2 || null), 'image/png');
          } catch {
            resolve(null);
          }
        },
        type,
        quality
      );
    } catch {
      try {
        canvas.toBlob((b) => resolve(b || null), 'image/png');
      } catch {
        resolve(null);
      }
    }
  });
}

async function errorPlaceholderBlob(pageNo) {
  try {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 1200;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#ccc';
    ctx.font = '28px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Error página ' + pageNo, c.width / 2, c.height / 2);
    return (await canvasToBlob(c, 'image/png')) || new Blob([], { type: 'image/png' });
  } catch {
    return new Blob([], { type: 'image/png' });
  }
}

/**
 * @param {Uint8Array|ArrayBuffer} data
 * @param {{ status?: (s:string)=>void, ac?: { cancelled?: boolean }, size?: number }} opts
 * @returns {Promise<{ pages: object[], close: ()=>void, isPdf: true }>}
 */
export async function openPdfFromBytes(data, opts = {}) {
  const status = typeof opts.status === 'function' ? opts.status : () => {};
  const ac = opts.ac || null;
  const cancelled = () => !!(ac && ac.cancelled);

  if (cancelled()) throw abortErr();

  const u8 = data instanceof Uint8Array
    ? data
    : new Uint8Array(data);
  const ab = u8.buffer.byteLength === u8.byteLength && u8.byteOffset === 0
    ? u8.buffer
    : u8.slice().buffer;

  status('Abriendo PDF…');
  let pdf;
  try {
    const task = pdfjs.getDocument({
      data: ab,
      // sin password: si es cifrado fallará con mensaje claro
      useSystemFonts: true,
      isEvalSupported: false,
    });
    pdf = await task.promise;
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (/password|encrypted|NeedPassword/i.test(msg)) {
      throw new Error('PDF cifrado o protegido con contraseña. No se puede abrir.');
    }
    throw new Error('No se pudo abrir el PDF: ' + (msg || 'error desconocido'));
  }
  if (cancelled()) {
    try { await pdf.destroy(); } catch (_) {}
    throw abortErr();
  }

  const num = pdf.numPages || 0;
  if (!num) {
    try { await pdf.destroy(); } catch (_) {}
    throw new Error('El PDF no tiene páginas.');
  }

  const sizeMb = (Number(opts.size) || u8.byteLength || 0) / (1024 * 1024);
  if (num > 250 || sizeMb > 120) {
    status(
      `Aviso: PDF grande (${num} pág., ${sizeMb.toFixed(1)} MB). Se abrirá igual; puede ir lento en móvil.`
    );
  } else {
    status(`PDF: ${num} páginas`);
  }

  /** @type {Map<number, Blob>} */
  const mem = new Map(); // máx. 2 bitmaps en RAM (además de pageCache del caller)
  const memOrder = [];

  const touchMem = (i, blob) => {
    mem.set(i, blob);
    const ix = memOrder.indexOf(i);
    if (ix >= 0) memOrder.splice(ix, 1);
    memOrder.push(i);
    while (memOrder.length > 2) {
      const old = memOrder.shift();
      mem.delete(old);
    }
  };

  const renderPage = async (i) => {
    if (cancelled()) throw abortErr();
    if (mem.has(i)) return mem.get(i);
    const pageNo = i + 1;
    try {
      const page = await pdf.getPage(pageNo);
      if (cancelled()) throw abortErr();
      const scale = scaleForPage(page);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const w = Math.max(1, Math.floor(viewport.width));
      const h = Math.max(1, Math.floor(viewport.height));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: true });
      // fondo transparente (no rellenar)
      await page.render({
        canvasContext: ctx,
        viewport,
        intent: 'display',
        background: 'transparent',
      }).promise;
      if (cancelled()) throw abortErr();
      let blob = await canvasToBlob(canvas, 'image/webp', 0.92);
      if (!blob || !blob.size) blob = await canvasToBlob(canvas, 'image/png');
      // liberar canvas
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch (_) {}
      if (!blob || !blob.size) blob = await errorPlaceholderBlob(pageNo);
      touchMem(i, blob);
      return blob;
    } catch (e) {
      if (e?.cancelled) throw e;
      console.warn('[pdf] render página', pageNo, e);
      const ph = await errorPlaceholderBlob(pageNo);
      touchMem(i, ph);
      return ph;
    }
  };

  const pages = [];
  for (let i = 0; i < num; i++) {
    const idx = i;
    const fname = String(idx + 1).padStart(4, '0') + '.webp';
    pages.push({
      filename: fname,
      name: fname,
      pdf: true,
      /** Lazy: usado por pageBlob ampliado */
      getBlob: () => renderPage(idx),
    });
  }
  // Marca en el array por si el reader quiere precarga mayor
  try {
    Object.defineProperty(pages, 'isPdf', { value: true, enumerable: false });
  } catch (_) {
    pages.isPdf = true;
  }

  const close = () => {
    mem.clear();
    memOrder.length = 0;
    try { pdf.destroy(); } catch (_) {}
  };

  return { pages, close, isPdf: true };
}

/** True si los 4 primeros bytes son %PDF */
export function isPdfMagic(u8) {
  if (!u8 || u8.length < 4) return false;
  return u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;
}
