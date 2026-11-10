/**
 * Detección de viñetas 2D estilo Kumiko (sin dependencias pesadas ni OpenCV).
 *
 * Características mejoradas:
 * 1. Todos los presets corren sobre el motor 2D Kumiko (Sobel + componentes conexas + flood-fill).
 * 2. Detección automática de color de medianil (calles blancas vs. negras / Noir).
 * 3. Prevención de fugas por bocadillos (cierre morfológico antes de flood-fill).
 * 4. Detección inteligente de splash pages / portadas / dobles páginas (evita trocear ilustraciones completas).
 * 5. Soporte de orden de lectura LTR (Occidental) y RTL (Manga).
 *
 * API exportada:
 *   detectPanelsFumiko(img, opts)
 *   detectPanelsKumikoGrok(img, opts)
 *   detectPanelsKumiko(img, opts)
 */

export function detectPanelsFumiko(img, opts = {}) {
  return runPipeline(img, opts, 'fumiko');
}

export function detectPanelsKumikoGrok(img, opts = {}) {
  return runPipeline(img, opts, 'kumiko-grok');
}

export function detectPanelsKumiko(img, opts = {}) {
  return runPipeline(img, opts, opts.mode || 'kumiko-grok');
}

function runPipeline(img, opts, mode) {
  const nw = img.naturalWidth || img.width || 0;
  const nh = img.naturalHeight || img.height || 0;
  if (!nw || !nh) return [];

  const maxW = clamp(Number(opts.detectW) || 600, 160, 960);
  const minAreaPct = clamp(Number(opts.minAreaPct) || 3, 0.5, 30) / 100;
  const bandMinPct = clamp(Number(opts.bandMinPct) || 4, 1, 20) / 100;
  const maxPanels = clamp(Number(opts.maxPanels) || 0, 0, 60);
  const paperFrac = clamp(Number(opts.paperFrac) || 38, 10, 80) / 100;

  const sc = Math.min(1, maxW / Math.max(nw, nh));
  const w = Math.max(32, Math.round(nw * sc));
  const h = Math.max(32, Math.round(nh * sc));

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  try { cv.width = 0; cv.height = 0; } catch (_) {}

  const N = w * h;
  const gray = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    gray[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
  }

  // --- Detección automática de color de medianil (calles blancas vs. negras / Noir) ---
  let cornerSum = 0, cornerCount = 0;
  const cw = Math.min(16, Math.max(4, Math.floor(w * 0.04)));
  const ch = Math.min(16, Math.max(4, Math.floor(h * 0.04)));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      cornerSum += gray[y * w + x];
      cornerSum += gray[y * w + (w - 1 - x)];
      cornerSum += gray[(h - 1 - y) * w + x];
      cornerSum += gray[(h - 1 - y) * w + (w - 1 - x)];
      cornerCount += 4;
    }
  }
  const cornerAvg = cornerCount ? (cornerSum / cornerCount) : 180;
  const isNoirEra = opts.era === 'Noir' || (opts.paperLum != null && Number(opts.paperLum) < 115);
  const isDarkGutter = isNoirEra || (cornerAvg < 105);

  // Gradiente Sobel 3x3
  const edge = sobelMag(gray, w, h);

  // Umbral de bordes calibrado por preset / luminancia
  let defaultEdgeThresh = mode === 'fumiko' ? 95 : 85;
  if (isDarkGutter) defaultEdgeThresh = 75;
  const edgeThresh = clamp(Number(opts.edgeThresh) || defaultEdgeThresh, 20, 200);

  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) bin[i] = edge[i] >= edgeThresh ? 1 : 0;

  // --- Cierre de fugas por bocadillos (Leak prevention) ---
  // Dilatación direccional para cerrar micro-brechas producidas por bocadillos
  // que atraviesan los marcos de viñetas antes de realizar el flood-fill.
  dilateInPlace(bin, w, h);
  dilateInPlace(bin, w, h);
  erodeInPlace(bin, w, h);

  let panels;

  if (mode === 'kumiko-grok') {
    const paper = new Uint8Array(N);
    if (isDarkGutter) {
      // Medianil oscuro: papel es negro / gris oscuro sin borde
      const darkThresh = Math.min(115, Math.max(45, Math.round(cornerAvg + 25)));
      for (let i = 0; i < N; i++) {
        paper[i] = (gray[i] <= darkThresh && !bin[i]) ? 1 : 0;
      }
    } else {
      // Medianil claro: papel es blanco / marfil sin borde
      const paperLum = clamp(opts.paperLum == null ? 175 : Number(opts.paperLum), 40, 250);
      for (let i = 0; i < N; i++) {
        paper[i] = (gray[i] >= paperLum && !bin[i]) ? 1 : 0;
      }
      let paperCount = 0;
      for (let i = 0; i < N; i++) if (paper[i]) paperCount++;
      if (paperCount / N < paperFrac * 0.25) {
        for (let i = 0; i < N; i++) paper[i] = (gray[i] >= paperLum - 25 && !bin[i]) ? 1 : 0;
      }
    }

    const outside = floodFromBorder(paper, w, h);
    const content = new Uint8Array(N);
    for (let i = 0; i < N; i++) content[i] = outside[i] ? 0 : 1;

    erodeInPlace(content, w, h);
    dilateInPlace(content, w, h);
    panels = componentsToPanels(content, w, h, minAreaPct, bandMinPct);
  } else {
    // Fumiko: máscara de bordes engrosada + flood fill de fondo exterior
    const thick = new Uint8Array(bin);
    dilateInPlace(thick, w, h);
    dilateInPlace(thick, w, h);

    const bg = new Uint8Array(N);
    for (let i = 0; i < N; i++) bg[i] = thick[i] ? 0 : 1;
    const outside = floodFromBorder(bg, w, h);
    const content = new Uint8Array(N);
    for (let i = 0; i < N; i++) content[i] = outside[i] ? 0 : 1;
    panels = componentsToPanels(content, w, h, minAreaPct, bandMinPct);
  }

  panels = groupNearbySmall(panels, 0.75);
  panels = mergeContained(panels, 0.5);
  panels = deoverlap(panels);
  panels = panels.filter((p) => p.w * p.h >= minAreaPct * 0.5 && p.w >= bandMinPct * 0.5 && p.h >= bandMinPct * 0.5);

  // --- Detección inteligente de páginas completas / Splash pages ---
  // Si sólo se detecta una caja que abarca prácticamente toda la página (>88% de ancho y alto),
  // se trata de una portada o splash page y no debe fragmentarse en viñetas.
  if (panels.length === 1 && panels[0].w > 0.88 && panels[0].h > 0.88) return [];
  if (panels.length === 0) return [];

  // Orden de lectura RTL (Manga) o LTR (Occidental)
  const isRtl = Boolean(opts.rtl || opts.era === 'Manga');
  panels = sortReadingOrder(panels, isRtl);

  if (maxPanels > 0 && panels.length > maxPanels) panels = panels.slice(0, maxPanels);
  return panels;
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) n = a;
  return Math.max(a, Math.min(b, n));
}

function sobelMag(gray, w, h) {
  const N = w * h;
  const out = new Uint8Array(N);
  for (let y = 1; y < h - 1; y++) {
    const yw = y * w;
    for (let x = 1; x < w - 1; x++) {
      const p00 = gray[yw - w + x - 1], p01 = gray[yw - w + x], p02 = gray[yw - w + x + 1];
      const p10 = gray[yw + x - 1], p12 = gray[yw + x + 1];
      const p20 = gray[yw + w + x - 1], p21 = gray[yw + w + x], p22 = gray[yw + w + x + 1];
      const gx = (-p00 + p02) + 2 * (-p10 + p12) + (-p20 + p22);
      const gy = (-p00 - 2 * p01 - p02) + (p20 + 2 * p21 + p22);
      const mag = (Math.abs(gx) + Math.abs(gy)) >> 2;
      out[yw + x] = mag > 255 ? 255 : mag;
    }
  }
  return out;
}

function dilateInPlace(bin, w, h) {
  const prev = new Uint8Array(bin);
  for (let y = 1; y < h - 1; y++) {
    const yw = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = yw + x;
      if (prev[i] || prev[i - 1] || prev[i + 1] || prev[i - w] || prev[i + w]) {
        bin[i] = 1;
      }
    }
  }
}

function erodeInPlace(bin, w, h) {
  const prev = new Uint8Array(bin);
  for (let y = 1; y < h - 1; y++) {
    const yw = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = yw + x;
      if (!prev[i - 1] || !prev[i + 1] || !prev[i - w] || !prev[i + w]) {
        bin[i] = 0;
      }
    }
  }
}

function floodFromBorder(walkable, w, h) {
  const N = w * h;
  const outside = new Uint8Array(N);
  const qx = new Int16Array(N);
  const qy = new Int16Array(N);
  let qh = 0, qt = 0;

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (outside[i]) return;
    if (walkable[i]) {
      outside[i] = 1;
      qx[qt] = x;
      qy[qt] = y;
      qt++;
    }
  };

  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

  while (qh < qt) {
    const x = qx[qh], y = qy[qh];
    qh++;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  return outside;
}

function componentsToPanels(mask, w, h, minAreaPct, bandMinPct) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const panels = [];
  const cx = new Int32Array(N);
  const cy = new Int32Array(N);
  const minPix = Math.max(30, Math.floor(N * (minAreaPct * 0.4)));

  for (let y0 = 0; y0 < h; y0++) {
    const y0w = y0 * w;
    for (let x0 = 0; x0 < w; x0++) {
      const s = y0w + x0;
      if (seen[s] || !mask[s]) continue;
      let head = 0, tail = 0;
      cx[tail] = x0; cy[tail] = y0; tail++;
      seen[s] = 1;
      let minX = x0, maxX = x0, minY = y0, maxY = y0, count = 0;

      while (head < tail) {
        const x = cx[head], y = cy[head];
        head++;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        const checkN = (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
          const j = ny * w + nx;
          if (seen[j] || !mask[j]) return;
          seen[j] = 1;
          cx[tail] = nx; cy[tail] = ny; tail++;
        };
        checkN(x - 1, y);
        checkN(x + 1, y);
        checkN(x, y - 1);
        checkN(x, y + 1);
      }

      if (count < minPix) continue;
      const bw = (maxX - minX + 1) / w;
      const bh = (maxY - minY + 1) / h;
      if (bw < bandMinPct * 0.6 || bh < bandMinPct * 0.6) continue;
      if (bw * bh < minAreaPct * 0.5) continue;
      panels.push({
        x: Math.max(0, minX / w),
        y: Math.max(0, minY / h),
        w: Math.min(1, bw),
        h: Math.min(1, bh),
      });
    }
  }
  return panels;
}

function groupNearbySmall(panels, factor) {
  if (!panels.length) return panels;
  let cur = panels.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    const used = new Uint8Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      if (used[i]) continue;
      let a = cur[i];
      for (let j = i + 1; j < cur.length; j++) {
        if (used[j]) continue;
        const b = cur[j];
        if (isClose(a, b, factor)) {
          a = unionBoxes([a, b]);
          used[j] = 1;
          changed = true;
        }
      }
      next.push(a);
      used[i] = 1;
    }
    cur = next;
  }
  return cur;
}

function isClose(a, b, factor) {
  const gapX = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const gapY = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  const maxGap = 0.025 * factor;
  return gapX <= maxGap && gapY <= maxGap;
}

function unionBoxes(list) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const b of list) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.01, y1 - y0) };
}

function mergeContained(panels, ratio) {
  const out = [];
  for (let i = 0; i < panels.length; i++) {
    const a = panels[i];
    let inside = false;
    for (let j = 0; j < panels.length; j++) {
      if (i === j) continue;
      const b = panels[j];
      const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
      const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
      if (x1 > x0 && y1 > y0) {
        const inter = (x1 - x0) * (y1 - y0);
        const areaA = a.w * a.h;
        if (inter / areaA >= ratio && b.w * b.h > areaA) { inside = true; break; }
      }
    }
    if (!inside) out.push(a);
  }
  return out;
}

function deoverlap(panels) {
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i], b = panels[j];
      const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
      const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
      if (x1 > x0 && y1 > y0) {
        const ow = x1 - x0, oh = y1 - y0;
        if (ow < oh) {
          if (a.x < b.x) a.w = Math.max(0.02, a.w - ow);
          else b.w = Math.max(0.02, b.w - ow);
        } else {
          if (a.y < b.y) a.h = Math.max(0.02, a.h - oh);
          else b.h = Math.max(0.02, b.h - oh);
        }
      }
    }
  }
  return panels;
}

function sortReadingOrder(panels, rtl = false) {
  if (!panels || panels.length <= 1) return panels || [];
  const sorted = panels.slice().sort((a, b) => (a.y + a.h * 0.5) - (b.y + b.h * 0.5));
  const rows = [];
  let curRow = [sorted[0]];
  let rowY = sorted[0].y;
  let rowH = sorted[0].h;

  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    const mid = p.y + p.h * 0.5;
    if (mid >= rowY && mid <= rowY + rowH * 1.15) {
      curRow.push(p);
      rowY = Math.min(rowY, p.y);
      rowH = Math.max(rowH, p.y + p.h - rowY);
    } else {
      curRow.sort((a, b) => rtl ? (b.x - a.x) : (a.x - b.x));
      rows.push(...curRow);
      curRow = [p];
      rowY = p.y;
      rowH = p.h;
    }
  }
  if (curRow.length) {
    curRow.sort((a, b) => rtl ? (b.x - a.x) : (a.x - b.x));
    rows.push(...curRow);
  }
  return rows;
}
