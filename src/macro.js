/**
 * Canales macro de editorial y secciones (caption "Sección:").
 * Título TG macro: `{Editorial}::Comics::tgstorage`
 * Canal normal: `{Canal}:{Editorial}::Comics::tgstorage`
 * Entrada LIB macro: { macro: true, name, group } (name suele = editorial)
 */
export const SEP = '::';
export const TSEP = ':';
export const LIBRARY_LABEL = 'Comics';
export const POST = SEP + 'tgstorage';

/** Título Telegram del canal macro de una editorial */
export function macroChannelTitle(editorial) {
  const ed = String(editorial || '').trim() || 'Sin editorial';
  return `${ed}${SEP}${LIBRARY_LABEL}${POST}`;
}

/** Título Telegram de un canal dedicado */
export function dedicatedChannelTitle(channelName, editorial) {
  const ch = String(channelName || '').trim();
  const ed = String(editorial || '').trim() || 'Sin editorial';
  return `${ch}${TSEP}${ed}${SEP}${LIBRARY_LABEL}${POST}`;
}

export function isMacroLibEntry(ch) {
  return !!(ch && (ch.macro === true || ch.isMacro === true));
}

/** ¿El título de Telegram corresponde a un macro de editorial? */
export function isMacroTelegramTitle(title) {
  const t = String(title || '').trim();
  // Editorial::Comics::tgstorage  (sin "Nombre:" delante)
  const re = new RegExp(
    `^([^${TSEP}]+)${SEP}${LIBRARY_LABEL}${POST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'i'
  );
  return re.test(t);
}

export function editorialFromMacroTitle(title) {
  const t = String(title || '').trim();
  const marker = `${SEP}${LIBRARY_LABEL}${POST}`;
  const i = t.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (i <= 0) return '';
  const head = t.slice(0, i);
  if (head.includes(TSEP)) return ''; // es canal dedicado
  return head.trim();
}

export function normalizeSectionKey(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Extrae Sección del caption (parseComicCaption o línea suelta).
 * @param {string} caption
 * @param {(t:string)=>object} [parseComicCaption]
 */
export function sectionFromCaption(caption, parseComicCaption) {
  const raw = String(caption || '');
  if (typeof parseComicCaption === 'function') {
    try {
      const p = parseComicCaption(raw) || {};
      if (p.section || p.seccion) return String(p.section || p.seccion).trim();
    } catch (_) {}
  }
  const m = raw.match(/^\s*Secci[oó]n\s*:\s*(.+)$/imu);
  return m ? String(m[1] || '').trim() : '';
}

/** Secciones únicas presentes en los archivos de un canal macro */
export function collectSectionsFromFiles(files, parseComicCaption) {
  const map = new Map(); // key -> display name
  for (const f of files || []) {
    const sec = sectionFromCaption(f?.caption || '', parseComicCaption);
    if (!sec) continue;
    const k = normalizeSectionKey(sec);
    if (!k) continue;
    if (!map.has(k)) map.set(k, sec);
  }
  return [...map.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

export function filesInSection(files, sectionLabel, parseComicCaption) {
  const want = normalizeSectionKey(sectionLabel);
  if (!want) return [];
  return (files || []).filter((f) => {
    const s = sectionFromCaption(f?.caption || '', parseComicCaption);
    return normalizeSectionKey(s) === want;
  });
}

/** Añade o sustituye la línea Sección: en un caption ya construido */
export function withSectionInCaption(caption, section) {
  const sec = String(section || '').trim();
  const text = String(caption || '').trim();
  if (!sec) return text;
  const line = 'Sección: ' + sec;
  if (!text) return line;
  if (/^\s*Secci[oó]n\s*:/imu.test(text)) {
    return text.replace(/^\s*Secci[oó]n\s*:.*$/imu, line);
  }
  // Tras "Nombre de archivo" si existe
  if (/^\s*Nombre de archivo\s*:/imu.test(text)) {
    return text.replace(
      /(^\s*Nombre de archivo\s*:.*$)/imu,
      (_, a) => a + '\n' + line
    );
  }
  return line + '\n' + text;
}
