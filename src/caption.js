/**
 * Ajuste del caption de Telegram (máx. 1024 caracteres).
 * - La Descripción SIEMPRE se sube: si no cabe se recorta por palabras y termina en "..."
 * - Nunca se recorta por líneas (antes se perdía la Descripción entera al cortar en el último salto de línea)
 * - La cabecera (Título, Serie, Guionista…) se respeta; solo se acorta si ni así cabe la Descripción
 * - "Nombre de archivo" nunca se toca (lo usa el parseo de nombres)
 * Telegram cuenta unidades UTF-16 (igual que String.length en JS) y un salto de línea = 1 carácter.
 */
export const TG_CAPTION_MAX = 1024;
const DESC_RE = /(?:^|\n)Descripción:[ \t]*/;
const MIN_DESC = 80; // mínimo de Descripción que se intenta conservar
const ELLIPSIS = '...';
const KV_RE = /^([^:：\n]{1,40}[:：]\s*)(.*)$/;

/** Recorta por palabras a `max` caracteres (incluidos los puntos suspensivos). */
export function cutWords(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  if (max <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(0, max));
  const room = max - ELLIPSIS.length;
  let cut = s.slice(0, room).replace(/[\uD800-\uDBFF]$/, '');
  const sp = cut.search(/\s+\S*$/);
  if (sp > room * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.\-–—]+$/, '') + ELLIPSIS;
}

function shrinkHead(headLines, budget) {
  const lines = headLines.slice();
  const total = () => lines.join('\n').length;
  let guard = 200;
  while (total() > budget && guard-- > 0) {
    let bi = -1, bl = 0;
    lines.forEach((l, i) => {
      if (/^\s*Nombre de archivo\s*:/i.test(l)) return;
      const m = l.match(KV_RE);
      const vlen = m ? m[2].length : l.length;
      if (vlen > 15 && l.length > bl) { bi = i; bl = l.length; }
    });
    if (bi < 0) break;
    const over = total() - budget;
    const l = lines[bi];
    const m = l.match(KV_RE);
    const key = m ? m[1] : '';
    const val = m ? m[2] : l;
    lines[bi] = key + cutWords(val, Math.max(12, val.length - over));
    if (lines[bi].length >= l.length) break; // sin progreso
  }
  return lines;
}

export function fitTelegramCaption(text, max = TG_CAPTION_MAX) {
  const s = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (s.length <= max) return s;
  const m = s.match(DESC_RE);
  if (!m) return cutWords(s, max);
  const head0 = s.slice(0, m.index).replace(/\s+$/, '');
  const body = s.slice(m.index + m[0].length).trim();
  const marker = (head0 ? '\n' : '') + 'Descripción: ';
  if (!body) return head0.length <= max ? head0 : cutWords(head0, max);
  const minDesc = Math.min(body.length, MIN_DESC);
  let head = head0;
  if (head.length + marker.length + minDesc > max) {
    head = shrinkHead(head0.split('\n'), max - marker.length - minDesc).join('\n');
  }
  const room = max - head.length - marker.length;
  if (room < 4) return cutWords(head + marker + body, max); // caso extremo
  return head + marker + cutWords(body, room);
}
