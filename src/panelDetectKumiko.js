/**
 * Detección de viñetas 2D estilo Kumiko (sin dependencias pesadas ni OpenCV).
 *
 * Mejoras aplicadas:
 * 1. Detección adaptativa de color de papel/márgenes (funciona en papel vintage 1978, newsprint, digital blanco y Noir).
 * 2. Muros morfológicos por trazos continuos (evita que tramas de puntos/screentones o bocadillos bloqueen el medianil).
 * 3. Prevención de fugas (leak prevention) con dilatación de muros y cierre de micro-roturas.
 * 4. Detección automática de medianiles negros (Noir) vs claros.
 * 5. Detección de splash pages / portadas (evita trocear ilustraciones completas).
 * 6. Soporte de lectura LTR (Occidental) y RTL (Manga).
 *
 * API:
 *   detectPanelsFumiko(img, opts) -> [{x,y,w,h}] normalizado 0..1
 *   detectPanelsKumikoGrok(img, opts) -> [{x,y,w,h}] normalizado 0..1
 *   detectPanelsKumiko(img, opts) -> [{x,y,w,h}] normalizado 0..1
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

  const maxW = clamp(Number(opts.detectW) || 560, 160, 960);
  const minAreaPct = clamp(Number(opts.minAreaPct) || 3, 0.5, 30) / 100;
  const bandMinPct = clamp(Number(opts.bandMinPct) || 4, 1, 20) / 100;
  const maxPanels = clamp(Number(opts.maxPanels) || 0, 0, 60);

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

  // --- 1. Muestreo adaptativo del color de margen / papel ---
  // Analizar la periferia exterior (3% de los bordes) para calibrar el fondo real
  const mw = Math.max(2, Math.floor(w * 0.035));
  const mh = Math.max(2, Math.floor(h * 0.035));
  const marginSamples = [];
  const step = Math.max(1, Math.floor(w / 80));
  for (let x = 0; x < w; x += step) {
    for (let y = 0; y < mh; y++) marginSamples.push(gray[y * w + x]);
    for (let y = h - mh; y < h; y++) marginSamples.push(gray[y * w + x]);
  }
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < mw; x++) marginSamples.push(gray[y * w + x]);
    for (let x = w - mw; x < w; x++) marginSamples.push(gray[y * w + x]);
  }
  marginSamples.sort((a, b) => a - b);
  const marginMed = marginSamples.length
    ? marginSamples[(marginSamples.length - 1) >> 1]
    : 180;

  const isNoirEra = opts.era === 'Noir' || (opts.paperLum != null && Number(opts.paperLum) < 110);
  const isDarkGutter = isNoirEra || (marginMed < 75);

  // Umbral dinámico de papel:
  // En papel claro (incluido newsprint amarillento de 1978 con lum ~150),
  // el papel es cualquier píxel cercano a la luminancia del margen.
  let thrPaper, thrBorder;
  if (isDarkGutter) {
    thrPaper = Math.min(85, Math.floor(marginMed + 35));
    thrBorder = Math.max(105, Math.floor(marginMed + 65));
  } else {
    thrPaper = Math.max(65, Math.floor(marginMed - 32));
    thrBorder = Math.min(125, Math.floor(marginMed - 45));
  }

  // Permite override manual si el usuario ajusta el slider en opciones
  if (opts.paperLum != null && Math.abs(Number(opts.paperLum) - 175) > 15) {
    thrPaper = clamp(Number(opts.paperLum), 40, 245);
  }
  if (opts.edgeThresh != null && Math.abs(Number(opts.edgeThresh) - 90) > 15) {
    thrBorder = clamp(Number(opts.edgeThresh), 20, 200);
  }

  // Máscara de papel (candidato a medianil por el que puede caminar el flood)
  const paper = new Uint8Array(N);
  if (isDarkGutter) {
    for (let i = 0; i < N; i++) if (gray[i] <= thrPaper) paper[i] = 1;
  } else {
    for (let i = 0; i < N; i++) if (gray[i] >= thrPaper) paper[i] = 1;
  }

  // --- 2. Detección de muros de viñeta (trazos continuos H y V) ---
  // Los marcos de cómic son líneas continuas largas (mínimo ~3.5% del tamaño de página).
  // Los screentones/tramas de puntos y dibujos no forman líneas continuas en los medianiles.
  const isWallPixel = isDarkGutter
    ? (val) => val >= thrBorder
    : (val) => val <= thrBorder;

  const minRunW = Math.max(4, Math.floor(w * 0.035));
  const minRunH = Math.max(4, Math.floor(h * 0.035));
  const wall = new Uint8Array(N);

  for (let y = 0; y < h; y++) {
    let x = 0;
    const yw = y * w;
    while (x < w) {
      if (!isWallPixel(gray[yw + x])) { x++; continue; }
      const x0 = x;
      while (x < w && isWallPixel(gray[yw + x])) x++;
      if (x - x0 >= minRunW) {
        for (let t = x0; t < x; t++) wall[yw + t] = 1;
      }
    }
  }

  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!isWallPixel(gray[y * w + x])) { y++; continue; }
      const y0 = y;
      while (y < h && isWallPixel(gray[y * w + x])) y++;
      if (y - y0 >= minRunH) {
        for (let t = y0; t < y; t++) wall[t * w + x] = 1;
      }
    }
  }

  // Gradiente Sobel para apoyar el cierre de bordes tenues
  const edge = sobelMag(gray, w, h);
  const sobelThresh = isDarkGutter ? 70 : 80;
  for (let i = 0; i < N; i++) {
    if (edge[i] >= sobelThresh && wall[i]) wall[i] = 1;
  }

  // Dilatación ligera de 2px en muros para sellar esquinas y fugas de bocadillos
  const wallSealed = dilatePass(wall, w, h, 2);

  // --- 3. Flood-fill desde el exterior sobre papel ---
  // El agua solo corre por papel libre de muros
  const outside = new Uint8Array(N);
  const qx = new Int32Array(N);
  const qy = new Int32Array(N);
  let qh = 0, qt = 0;

  const pushSeed = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (outside[i] || wallSealed[i] || !paper[i]) return;
    outside[i] = 1;
    qx[qt] = x; qy[qt] = y; qt++;
  };

  for (let x = 0; x < w; x++) { pushSeed(x, 0); pushSeed(x, h - 1); }
  for (let y = 0; y < h; y++) { pushSeed(0, y); pushSeed(w - 1, y); }

  // Semillas en franjas exteriores de seguridad (por si el borde tiene marcas de corte)
  const seedBand = Math.max(2, Math.floor(Math.min(w, h) * 0.015));
  for (let t = 1; t <= seedBand; t++) {
    for (let x = 0; x < w; x += 2) { pushSeed(x, t); pushSeed(x, h - 1 - t); }
    for (let y = 0; y < h; y += 2) { pushSeed(t, y); pushSeed(w - 1 - t, y); }
  }

  while (qh < qt) {
    const x = qx[qh], y = qy[qh]; qh++;
    const xm = x > 0, xp = x + 1 < w, ym = y > 0, yp = y + 1 < h;
    if (xm) pushSeed(x - 1, y);
    if (xp) pushSeed(x + 1, y);
    if (ym) pushSeed(x, y - 1);
    if (yp) pushSeed(x, y + 1);
  }

  // --- 4. Componentes conexas de viñeta (islas no inundadas) ---
  const content = new Uint8Array(N);
  for (let i = 0; i < N; i++) content[i] = outside[i] ? 0 : 1;

  let panels = componentsToPanels(content, w, h, minAreaPct, bandMinPct);

  // Limpieza y consolidación de cajas
  panels = groupNearbySmall(panels, 0.7);
  panels = mergeContained(panels, 0.5);
  panels = deoverlap(panels);

  // --- 5. Fallback 1D por proyección de perfiles si 2D falló o devolvió 0/1 viñeta gigante ---
  const isRtl = Boolean(opts.rtl || opts.era === 'Manga');
  if (panels.length === 0 || (panels.length === 1 && panels[0].w > 0.86 && panels[0].h > 0.86)) {
    const p1D = detectPanels1DProjection(gray, w, h, isDarkGutter, thrPaper, isRtl);
    if (p1D && p1D.length) {
      panels = p1D;
    }
  }

  // Orden de lectura (RTL para Manga, LTR para Occidental)
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
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const yw = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = yw + x;
      const gx =
        -gray[i - w - 1] + gray[i - w + 1]
        - 2 * gray[i - 1] + 2 * gray[i + 1]
        - gray[i + w - 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
        + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const m = (Math.abs(gx) + Math.abs(gy)) >> 2;
      out[i] = m > 255 ? 255 : m;
    }
  }
  return out;
}

function dilatePass(src, w, h, passes = 1) {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(cur);
    for (let y = 1; y < h - 1; y++) {
      const yw = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = yw + x;
        if (cur[i] || cur[i - 1] || cur[i + 1] || cur[i - w] || cur[i + w]) {
          out[i] = 1;
        }
      }
    }
    cur = out;
  }
  return cur;
}

function componentsToPanels(mask, w, h, minAreaPct, bandMinPct) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const cx = new Int32Array(N);
  const cy = new Int32Array(N);
  const minPix = Math.max(30, Math.floor(N * (minAreaPct * 0.35)));
  const panels = [];

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
        const x = cx[head], y = cy[head]; head++;
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
      if (bw < bandMinPct * 0.5 || bh < bandMinPct * 0.5) continue;
      if (bw * bh < minAreaPct * 0.4) continue;
      // Descartar líneas aisladas de borde
      if (bw > 0.94 && bh < 0.05) continue;
      if (bh > 0.94 && bw < 0.05) continue;

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
  if (panels.length < 2) return panels;
  const small = panels.filter((p) => p.w * p.h < 0.08);
  const big = panels.filter((p) => p.w * p.h >= 0.08);
  if (small.length < 2) return panels;
  const used = new Set();
  const out = [...big];
  for (let i = 0; i < small.length; i++) {
    if (used.has(i)) continue;
    const group = [small[i]];
    used.add(i);
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < small.length; j++) {
        if (used.has(j)) continue;
        const a = small[j];
        if (group.some((b) => isClose(a, b, factor))) {
          group.push(a);
          used.add(j);
          changed = true;
        }
      }
    }
    if (group.length === 1) out.push(group[0]);
    else out.push(unionBoxes(group));
  }
  return out;
}

function isClose(a, b, factor) {
  const c1x = a.x + a.w / 2, c1y = a.y + a.h / 2;
  const c2x = b.x + b.w / 2, c2y = b.y + b.h / 2;
  return Math.abs(c1x - c2x) <= (a.w + b.w) * factor
    && Math.abs(c1y - c2y) <= (a.h + b.h) * factor;
}

function unionBoxes(list) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of list) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.w);
    y1 = Math.max(y1, p.y + p.h);
  }
  return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.01, y1 - y0) };
}

function mergeContained(panels, ratio) {
  if (panels.length < 2) return panels;
  const kill = new Set();
  for (let i = 0; i < panels.length; i++) {
    for (let j = 0; j < panels.length; j++) {
      if (i === j || kill.has(j)) continue;
      const a = panels[i], b = panels[j];
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const inter = ox * oy;
      if (inter / (b.w * b.h) > ratio) kill.add(j);
    }
  }
  return panels.filter((_, i) => !kill.has(i));
}

function deoverlap(panels) {
  const p = panels.map((x) => ({ ...x }));
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < p.length; j++) {
      if (i === j) continue;
      const a = p[i], b = p[j];
      const ox0 = Math.max(a.x, b.x);
      const oy0 = Math.max(a.y, b.y);
      const ox1 = Math.min(a.x + a.w, b.x + b.w);
      const oy1 = Math.min(a.y + a.h, b.y + b.h);
      if (ox1 <= ox0 || oy1 <= oy0) continue;
      const ow = ox1 - ox0, oh = oy1 - oy0;
      if (ow < oh && Math.abs((a.x + a.w) - (b.x + b.w)) < 0.02) {
        if (a.x <= b.x) { a.w = Math.max(0.02, ox0 - a.x); b.x = ox1; b.w = Math.max(0.02, b.x + b.w - ox1); }
      } else if (oh <= ow && Math.abs((a.y + a.h) - (b.y + b.h)) < 0.02) {
        if (a.y <= b.y) { a.h = Math.max(0.02, oy0 - a.y); b.y = oy1; b.h = Math.max(0.02, b.y + b.h - oy1); }
      }
    }
  }
  return p.filter((x) => x.w > 0.02 && x.h > 0.02);
}

function sortReadingOrder(panels, rtl = false) {
  const sorted = [...panels].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const p of sorted) {
    let placed = false;
    for (const row of rows) {
      const ref = row[0];
      const above = ref.y <= p.y ? ref : p;
      const below = ref.y <= p.y ? p : ref;
      if (below.y > above.y + above.h) continue;
      const inter = Math.min(above.y + above.h, below.y + below.h) - below.y;
      const minH = Math.min(above.h, below.h) || 1e-6;
      if (inter / minH >= 1 / 3) {
        row.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([p]);
  }
  const out = [];
  for (const row of rows) {
    row.sort((a, b) => rtl ? (b.x - a.x) : (a.x - b.x));
    out.push(...row);
  }
  return out;
}


function detectPanels1DProjection(gray, w, h, isDarkGutter, thrPaper, isRtl) {
  const rowGutter = new Uint8Array(h);
  const gutterRatioThr = 0.80;
  for (let y = 0; y < h; y++) {
    const yw = y * w;
    let paperCount = 0;
    for (let x = 0; x < w; x++) {
      const g = gray[yw + x];
      const isPaper = isDarkGutter ? (g <= thrPaper) : (g >= thrPaper);
      if (isPaper) paperCount++;
    }
    if (paperCount / w >= gutterRatioThr) rowGutter[y] = 1;
  }

  const rowBands = [];
  const minBandH = Math.max(10, Math.floor(h * 0.07));
  let inBand = false, bStart = 0;
  for (let y = 0; y < h; y++) {
    if (!rowGutter[y]) {
      if (!inBand) { inBand = true; bStart = y; }
    } else {
      if (inBand) {
        inBand = false;
        if (y - bStart >= minBandH) rowBands.push([bStart, y - 1]);
      }
    }
  }
  if (inBand && h - bStart >= minBandH) rowBands.push([bStart, h - 1]);

  const effectiveBands = rowBands.length ? rowBands : [[Math.floor(h * 0.03), Math.floor(h * 0.97)]];
  const panels = [];
  const minPanelW = Math.max(10, Math.floor(w * 0.09));

  for (const [y0, y1] of effectiveBands) {
    const bandH = y1 - y0 + 1;
    const colGutter = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let paperCount = 0;
      for (let y = y0; y <= y1; y++) {
        const g = gray[y * w + x];
        const isPaper = isDarkGutter ? (g <= thrPaper) : (g >= thrPaper);
        if (isPaper) paperCount++;
      }
      if (paperCount / bandH >= gutterRatioThr) colGutter[x] = 1;
    }

    const colCells = [];
    let inCol = false, cStart = 0;
    for (let x = 0; x < w; x++) {
      if (!colGutter[x]) {
        if (!inCol) { inCol = true; cStart = x; }
      } else {
        if (inCol) {
          inCol = false;
          if (x - cStart >= minPanelW) colCells.push([cStart, x - 1]);
        }
      }
    }
    if (inCol && w - cStart >= minPanelW) colCells.push([cStart, w - 1]);

    const effectiveCols = colCells.length ? colCells : [[Math.floor(w * 0.03), Math.floor(w * 0.97)]];

    for (const [x0, x1] of effectiveCols) {
      const pw = (x1 - x0 + 1) / w;
      const ph = bandH / h;
      if (pw >= 0.08 && ph >= 0.05) {
        panels.push({
          x: Math.max(0, Math.min(0.98, x0 / w)),
          y: Math.max(0, Math.min(0.98, y0 / h)),
          w: Math.max(0.04, Math.min(1, pw)),
          h: Math.max(0.04, Math.min(1, ph)),
        });
      }
    }
  }

  if (panels.length >= 2) {
    return sortReadingOrder(panels, isRtl);
  }

  // Fallback final si la página es ilustración/portada única: recortar margen exterior
  let minX = w - 1, maxX = 0, minY = h - 1, maxY = 0, hasContent = false;
  for (let y = 0; y < h; y += 2) {
    const yw = y * w;
    for (let x = 0; x < w; x += 2) {
      const g = gray[yw + x];
      const isContent = isDarkGutter ? (g > thrPaper) : (g < thrPaper);
      if (isContent) {
        hasContent = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (hasContent && maxX > minX + 20 && maxY > minY + 20) {
    return [{
      x: Math.max(0, minX / w),
      y: Math.max(0, minY / h),
      w: Math.max(0.2, (maxX - minX + 1) / w),
      h: Math.max(0.2, (maxY - minY + 1) / h),
    }];
  }

  return [{ x: 0.02, y: 0.02, w: 0.96, h: 0.96 }];
}
