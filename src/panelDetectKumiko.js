/**
 * Detección de viñetas estilo Kumiko (sin OpenCV).
 *
 * Fumiko:         pipeline cercano a njean42/kumiko
 *   gray → gradiente (Sobel-like) → threshold → componentes (contornos) →
 *   filtrar pequeños → agrupar cercanos → merge contenidos → deoverlap → orden LTR
 *
 * Kumiko-Grok:    misma base + relleno de “papel” exterior (idea híbrida TGComic)
 *   para mejorar cuando el medianil es claro pero el marco no cierra del todo.
 *
 * API:
 *   detectPanelsFumiko(img, opts) -> [{x,y,w,h}] normalizado 0..1
 *   detectPanelsKumikoGrok(img, opts) -> igual
 *
 * opts (opcionales, alineados con prefs del visor):
 *   detectW, edgeThresh, minAreaPct, bandMinPct, maxPanels, paperLum, paperFrac
 */
export function detectPanelsFumiko(img, opts = {}) {
  return runPipeline(img, opts, 'fumiko');
}

export function detectPanelsKumikoGrok(img, opts = {}) {
  return runPipeline(img, opts, 'kumiko-grok');
}

function runPipeline(img, opts, mode) {
  const nw = img.naturalWidth || img.width || 0;
  const nh = img.naturalHeight || img.height || 0;
  if (!nw || !nh) return [];

  const maxW = clamp(Number(opts.detectW) || 640, 160, 960);
  const edgeThresh = clamp(Number(opts.edgeThresh) || 100, 20, 200);
  const minAreaPct = clamp(Number(opts.minAreaPct) || 3, 0.5, 30) / 100;
  const bandMinPct = clamp(Number(opts.bandMinPct) || 4, 1, 20) / 100;
  const maxPanels = clamp(Number(opts.maxPanels) || 0, 0, 60);
  const paperLum = clamp(Number(opts.paperLum) || 175, 120, 250);
  const paperFrac = clamp(Number(opts.paperFrac) || 40, 10, 80) / 100;

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

  // Gradiente tipo Sobel 3×3 (aprox. |Gx|+|Gy| → 0..255)
  const edge = sobelMag(gray, w, h);

  // Threshold fijo como Kumiko (~100 sobre Sobel)
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) bin[i] = edge[i] >= edgeThresh ? 1 : 0;

  // Cierre ligero: dilate 1 + erode 1 (une puntos de trama / marcos rotos)
  dilateInPlace(bin, w, h);
  erodeInPlace(bin, w, h);

  let panels;

  if (mode === 'kumiko-grok') {
    // Híbrido: bordes + flood de “papel” desde el borde de página
    const paper = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      // papel claro O no-borde → candidato a medianil/fondo
      paper[i] = gray[i] >= paperLum && !bin[i] ? 1 : 0;
    }
    // Si hay poco “papel”, relajar
    let paperCount = 0;
    for (let i = 0; i < N; i++) if (paper[i]) paperCount++;
    if (paperCount / N < paperFrac * 0.25) {
      for (let i = 0; i < N; i++) paper[i] = gray[i] >= paperLum - 25 ? 1 : 0;
    }
    const outside = floodFromBorder(paper, w, h);
    // Viñeta = no outside y no solo ruido de borde fino
    const content = new Uint8Array(N);
    for (let i = 0; i < N; i++) content[i] = outside[i] ? 0 : 1;
    // Abrir un poco para romper puentes
    erodeInPlace(content, w, h);
    dilateInPlace(content, w, h);
    panels = componentsToPanels(content, w, h, minAreaPct, bandMinPct);
  } else {
    // Fumiko: componentes sobre máscara de bordes dilatada → relleno por bbox no;
    // mejor: dilatar bordes, flood-fill fondos, invertir (islas internas = viñetas)
    const thick = new Uint8Array(bin);
    dilateInPlace(thick, w, h);
    dilateInPlace(thick, w, h);
    // Fondo = no-borde; flood desde margen de página
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

  // Splash: una sola caja que cubre casi toda la página → sin viñetas (página completa)
  if (panels.length === 1 && panels[0].w > 0.9 && panels[0].h > 0.9) return [];
  if (panels.length === 0) return [];

  panels = sortReadingOrder(panels);
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
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] + gray[i - w + 1]
        - 2 * gray[i - 1] + 2 * gray[i + 1]
        - gray[i + w - 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
        + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const m = Math.abs(gx) + Math.abs(gy);
      out[i] = m > 255 ? 255 : m;
    }
  }
  return out;
}

function dilateInPlace(bin, w, h) {
  const src = bin.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (src[i]) continue;
      if (src[i - 1] || src[i + 1] || src[i - w] || src[i + w]) bin[i] = 1;
    }
  }
}

function erodeInPlace(bin, w, h) {
  const src = bin.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!src[i]) continue;
      if (!src[i - 1] || !src[i + 1] || !src[i - w] || !src[i + w]) bin[i] = 0;
    }
  }
}

/** Flood-fill 4-conectado desde el borde sobre máscara walkable (1 = se puede caminar). */
function floodFromBorder(walkable, w, h) {
  const N = w * h;
  const out = new Uint8Array(N);
  const qx = new Int32Array(N);
  const qy = new Int32Array(N);
  let qh = 0, qt = 0;
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (out[i] || !walkable[i]) return;
    out[i] = 1;
    qx[qt] = x; qy[qt] = y; qt++;
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (qh < qt) {
    const x = qx[qh], y = qy[qh]; qh++;
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }
  return out;
}

function componentsToPanels(mask, w, h, minAreaPct, bandMinPct) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const cx = new Int32Array(N);
  const cy = new Int32Array(N);
  const minPix = Math.max(24, Math.floor(N * minAreaPct * 0.35));
  const panels = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const s = y0 * w + x0;
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
        const tryN = (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
          const j = ny * w + nx;
          if (seen[j] || !mask[j]) return;
          seen[j] = 1;
          cx[tail] = nx; cy[tail] = ny; tail++;
        };
        tryN(x - 1, y); tryN(x + 1, y); tryN(x, y - 1); tryN(x, y + 1);
      }
      if (count < minPix) continue;
      const bw = (maxX - minX + 1) / w;
      const bh = (maxY - minY + 1) / h;
      if (bw < bandMinPct * 0.6 || bh < bandMinPct * 0.6) continue;
      if (bw * bh < minAreaPct * 0.4) continue;
      // basura alargada (línea)
      if (bw > 0.92 && bh < 0.06) continue;
      if (bh > 0.92 && bw < 0.06) continue;
      panels.push({ x: minX / w, y: minY / h, w: bw, h: bh });
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
        const hit = group.some((b) => isClose(a, b, factor));
        if (hit) { group.push(a); used.add(j); changed = true; }
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
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
        // cortar verticalmente
        if (a.x <= b.x) { a.w = Math.max(0.02, ox0 - a.x); b.x = ox1; b.w = Math.max(0.02, b.x + b.w - ox1); }
      } else if (oh <= ow && Math.abs((a.y + a.h) - (b.y + b.h)) < 0.02) {
        if (a.y <= b.y) { a.h = Math.max(0.02, oy0 - a.y); b.y = oy1; b.h = Math.max(0.02, b.y + b.h - oy1); }
      }
    }
  }
  return p.filter((x) => x.w > 0.02 && x.h > 0.02);
}

function sortReadingOrder(panels) {
  // Filas: solape vertical >= 1/3 altura mínima (como Kumiko same_row)
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
    row.sort((a, b) => a.x - b.x);
    out.push(...row);
  }
  return out;
}
