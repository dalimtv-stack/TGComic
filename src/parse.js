/**
 * Parseo de nombres de cómic / series.
 */
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export const stripExt = (n) => n.replace(/\.cb[zr]$/i, '');

// Nombre limpio: sin extensión, guiones bajos, etiquetas [..] (..) ni marcas @sitio
export const clean = (n) => stripExt(n).replace(/_/g, ' ').replace(/\s*[(\[][^)\]]*[)\]]/g, '').replace(/\s*@\S+/g, '').replace(/\s+/g, ' ').trim();
// Número al final (legado); admite sufijo de letra (07b, 1a)
const NUM = /[\s._-]*(?:#|n[º°]\.?|no\.|vol\.?|cap\.?|issue|núm\.?|parte|part|tomo)?\s*\d+(?:\.\d+)?[a-zA-Z]?(?:\s*(?:de|of)\s*\d+)?\s*$/i;
const FIRST_ISSUE = /^(.+?)[\s._-]+(?:#|n[º°]\.?|no\.?|vol\.?|cap\.?|issue|núm\.?)?\s*\d+(?:\.\d+)?[a-zA-Z]?(?:\b|$)/i;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Quita (paréntesis), [corchetes] y créditos "por Grupo" del tramo info */
const cleanInfo = (s) => (s || '')
  .replace(/\s*\[[^\]]*\]/g, '')
  .replace(/\s*\((?!\d+\s*de\s*\d+)[^)]*\)/gi, '')
  .replace(/\s+por\s+\S.*$/i, '')
  .replace(/\s+/g, ' ')
  .trim();
/**
 * Formatos preferidos:
 * 1.  [channel] - [serie] #[n|Special|Especial|Extra] [- info]
 * 2.  [serie] #[n|Special|Especial|Extra] [- info]
 * 3.  [serie] [n|nX|n de m] [- info]   (sin #, p.ej. "Fabulas 07b - título", "Coleccionable 01 de 40")
 * No se muestra [channel]. [corchetes] ocultos.
 */
// Número de número: 12, 07b, 1.5, 01 de 40, 3 of 12
const ISSUE_NUM = '(?:\\d+(?:\\.\\d+)?[a-zA-Z]?(?:\\s*(?:de|of)\\s*\\d+)?)';
// Marcador completo: número o Special / Especial / Extra
const ISSUE_TAG = `(?:${ISSUE_NUM}|Special|Especial|Extra)`;
export function parseComicName(name, channelName) {
  // Quitar [corchetes], @sitios y basura; dejar el patrón serie #n
  const raw = stripExt(name).replace(/_/g, ' ')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\((?!\d+\s*de\s*\d+)[^)]*\)/gi, '')
    .replace(/\s*@\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  const ch = (channelName || '').trim();
  const normTag = (tag) => {
    let number = String(tag || '').trim();
    const low = number.toLowerCase();
    if (low === 'special') return 'Special';
    if (low === 'especial') return 'Especial';
    if (low === 'extra') return 'Extra';
    return number;
  };
  const finish = (series, tag, info, rangeEnd) => {
    series = (series || '').trim();
    if (!series) return null;
    return {
      series,
      number: normTag(tag),
      rangeEnd: rangeEnd ? normTag(rangeEnd) : '',
      info: cleanInfo(info || ''),
      channel: ch || '',
    };
  };
  const stripCh = (series) => {
    if (!ch) return series;
    return series.replace(new RegExp(`^${escRe(ch)}\\s*-\\s*`, 'i'), '').trim() || series;
  };
  // Rango: "Crossed - Dead Or Alive #01 - #02"
  const reRange = new RegExp(`^(.+?)\\s*#\\s*(${ISSUE_TAG})\\s*-\\s*#\\s*(${ISSUE_TAG})\\s*$`, 'i');
  const mRange = raw.match(reRange);
  if (mRange) {
    const out = finish(stripCh(mRange[1]), mRange[2], '', mRange[3]);
    if (out) return out;
  }
  // Canal - serie #n [- info]
  if (ch) {
    const re1 = new RegExp(
      `^${escRe(ch)}\\s*-\\s*(.+?)\\s*#\\s*(${ISSUE_TAG})(?:\\s*-?\\s+(.+))?\\s*$`,
      'i'
    );
    const m1 = raw.match(re1);
    if (m1) {
      // Evitar tratar "#01 - #02" como info si reRange falló por canal
      let info = m1[3] || '';
      const rangeInInfo = info.match(new RegExp(`^#\\s*(${ISSUE_TAG})\\s*$`, 'i'));
      if (rangeInInfo) {
        const out = finish(m1[1], m1[2], '', rangeInInfo[1]);
        if (out) return out;
      }
      const out = finish(m1[1], m1[2], info);
      if (out) return out;
    }
  }
  // Serie #n [- info]  (info no empieza por #n de rango ya cubierto)
  const re2 = new RegExp(`^(.+?)\\s*#\\s*(${ISSUE_TAG})(?:\\s*-?\\s+(.+))?\\s*$`, 'i');
  const m2 = raw.match(re2);
  if (m2) {
    let info = m2[3] || '';
    const rangeInInfo = info.match(new RegExp(`^#\\s*(${ISSUE_TAG})\\s*$`, 'i'));
    if (rangeInInfo) {
      const out = finish(stripCh(m2[1]), m2[2], '', rangeInInfo[1]);
      if (out) return out;
    }
    const out = finish(stripCh(m2[1]), m2[2], info);
    if (out) return out;
  }
  // Sin #: Canal - serie 07b [- info]
  if (ch) {
    const re3 = new RegExp(
      `^${escRe(ch)}\\s*-\\s*(.+?)\\s+(${ISSUE_TAG})(?:\\s*-?\\s+(.+))?\\s*$`,
      'i'
    );
    const m3 = raw.match(re3);
    if (m3) {
      const out = finish(m3[1], m3[2], m3[3] || '');
      if (out) return out;
    }
  }
  // Sin #: Serie 07b [- info]  (p.ej. "Fabulas 07b - 1001 Noches…")
  const re4 = new RegExp(`^(.+?)\\s+(${ISSUE_TAG})(?:\\s*-?\\s+(.+))?\\s*$`, 'i');
  const m4 = raw.match(re4);
  if (m4) {
    const ser = stripCh(m4[1]);
    if (ser && ser.length >= 2 && !/^\d+$/.test(ser)) {
      const out = finish(ser, m4[2], m4[3] || '');
      if (out) return out;
    }
  }
  return null;
}
/** Etiqueta visible: "#01", "#01 - #02", "#Extra - Batmito 1" */
export function issueDisplay(parsed) {
  if (!parsed) return '';
  if (parsed.rangeEnd) return `#${parsed.number} - #${parsed.rangeEnd}`;
  const base = '#' + parsed.number;
  return parsed.info ? `${base} - ${parsed.info}` : base;
}

export function comicDisplay(name, channelName) {
  const p = parseComicName(name, channelName);
  if (p) {
    const iss = issueDisplay(p);
    return p.series ? `${p.series} ${iss}` : iss;
  }
  return clean(name);
}
/** Base de serie (legado si no hay formato nuevo) */
export function seriesBase(name, channelName) {
  const p = parseComicName(name, channelName);
  if (p?.series) return p.series;
  const c = clean(name);
  if (!c) return '';
  const m = c.match(FIRST_ISSUE);
  if (m) {
    const base = m[1].replace(/[\s._-]+$/, '').trim();
    if (base.length >= 3 && !/^\d+$/.test(base)) return base;
  }
  const b = c.replace(NUM, '').replace(/[\s._-]+$/, '').trim();
  if (b && b !== c && b.length >= 3) return b;
  return '';
}
// Agrupa por serie; los especiales sin número que empiezan igual se unen
export function groupSeries(files, channelName) {
  const by = new Map(), loose = [];
  for (const f of files) {
    const p = parseComicName(f.name, channelName);
    const b = p?.series || seriesBase(f.name, channelName);
    const c = p ? comicDisplay(f.name, channelName) : clean(f.name);
    if (b) {
      const k = b.toLowerCase();
      (by.get(k) || by.set(k, { label: b, files: [] }).get(k)).files.push(f);
    } else {
      loose.push([f, c]);
    }
  }
  const groups = [...by.values()], rest = [];
  for (const [f, c] of loose) {
    const cl = c.toLowerCase();
    const g = groups.filter((x) => {
      const l = x.label.toLowerCase();
      return cl.startsWith(l) && !/[\p{L}\d]/u.test(cl[l.length] || ' ');
    }).sort((x, y) => y.label.length - x.label.length)[0];
    if (g) g.files.push(f); else rest.push({ label: c, files: [f] });
  }
  return [...groups, ...rest]
    .map((g) => ({
      label: g.label,
      files: g.files.sort((x, y) => natural(comicDisplay(x.name, channelName), comicDisplay(y.name, channelName))),
    }))
    .sort((x, y) => natural(x.label, y.label));
}


/** Etiqueta de número sin el nombre de la serie */
export function issueLabel(series, f, channelName) {
  const p = parseComicName(f.name, channelName);
  if (p && p.series.toLowerCase() === series.toLowerCase()) return issueDisplay(p);
  const c = clean(f.name);
  let r = c.toLowerCase().startsWith(series.toLowerCase()) ? c.slice(series.length) : c;
  r = r.replace(/^[\s._-]+/, '');
  if (/^\d/.test(r)) r = '#' + r;
  return r || c;
}

