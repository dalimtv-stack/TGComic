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
  if (!ch) return false;
  if (ch.macro === true || ch.isMacro === true) return true;
  // Explícito no-macro (canal dedicado Nombre:Editorial aunque Nombre === Editorial)
  if (ch.macro === false || ch.isMacro === false) return false;
  // LIB antigua sin flag: macro real tiene name === group (título Editorial::Comics::tgstorage)
  const n = String(ch.name || '').trim().toLowerCase();
  const g = String(ch.group || '').trim().toLowerCase();
  return !!(n && g && n === g);
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
export function collectSectionsFromFiles(files, parseComicCaption, chId) {
  const map = new Map(); // key -> display name
  for (const f of files || []) {
    let sec = sectionFromCaption(f?.caption || '', parseComicCaption);
    if (!sec && chId != null && f?.id != null) sec = getLocalSection(chId, f.id);
    if (!sec) continue;
    const k = normalizeSectionKey(sec);
    if (!k) continue;
    if (!map.has(k)) map.set(k, sec);
  }
  return [...map.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}


/** Override local de sección (reenvíos / cuando no se puede editar caption). */
export function localSectionKey(chId, msgId) {
  return 'secOverride:' + String(chId) + ':' + String(msgId);
}
export function getLocalSection(chId, msgId) {
  try {
    const v = localStorage.getItem(localSectionKey(chId, msgId));
    return v != null ? String(v).trim() : '';
  } catch (_) { return ''; }
}
export function setLocalSection(chId, msgId, section) {
  const k = localSectionKey(chId, msgId);
  const sec = String(section || '').trim();
  try {
    if (!sec) localStorage.removeItem(k);
    else localStorage.setItem(k, sec);
  } catch (_) {}
  try {
    // Si sync está cargado, anotar para multi-dispositivo
    const sync = globalThis.__tgcomicSync;
    if (sync && typeof sync.touchKey === 'function') sync.touchKey(k);
  } catch (_) {}
}
/** Sección efectiva: caption Telegram, si no override local. */
export function effectiveSection(ch, f, parseComicCaption) {
  const fromCap = sectionFromCaption(f?.caption || '', parseComicCaption);
  if (fromCap) return fromCap;
  if (ch?.id != null && f?.id != null) return getLocalSection(ch.id, f.id);
  return '';
}

export function filesInSection(files, sectionLabel, parseComicCaption, chId) {
  const want = normalizeSectionKey(sectionLabel);
  if (!want) return [];
  return (files || []).filter((f) => {
    let s = sectionFromCaption(f?.caption || '', parseComicCaption);
    if (!s && chId != null && f?.id != null) s = getLocalSection(chId, f.id);
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


/** Etiqueta de "canal" para UI: sección si el contenedor es macro */
export function displayChannelForComic(ch, f, channelDisplayNameFn) {
  if (isMacroLibEntry(ch)) {
    const sec = sectionFromCaption(f?.caption || '');
    return sec || '(Sin sección)';
  }
  if (typeof channelDisplayNameFn === 'function') {
    try { return channelDisplayNameFn(ch) || ch?.name || ''; } catch (_) {}
  }
  return ch?.name || '';
}

/** Nombre a usar en el archivo al "incluir canal": sección o nombre real */
export function channelNameForFile(ch, sectionLabel, channelDisplayNameFn) {
  const sec = String(sectionLabel || '').trim();
  if (sec) return sec;
  if (isMacroLibEntry(ch)) return '';
  if (typeof channelDisplayNameFn === 'function') {
    try { return channelDisplayNameFn(ch) || ch?.name || ''; } catch (_) {}
  }
  return ch?.name || '';
}

/**
 * Cuenta ítems de primer nivel bajo una editorial: canales reales + secciones de macros.
 * @param {Array} lib
 * @param {string} groupName
 * @param {(ch)=>any[]} getFilesSync  // sync reader (kv already loaded) optional
 */
export function countNavChannels(lib, groupName, filesByChId = {}) {
  const g = String(groupName || '');
  let n = 0;
  for (const ch of lib || []) {
    if (String(ch.group || '') !== g) continue;
    if (isMacroLibEntry(ch)) {
      const files = filesByChId[String(ch.id)] || [];
      const secs = collectSectionsFromFiles(files, (cap) => {
        const s = sectionFromCaption(cap);
        return s ? { section: s } : {};
      });
      n += secs.length;
      // huérfanos sin sección: cuentan como 1 tarjeta especial
      const orphan = (files || []).some((f) => !sectionFromCaption(f?.caption || ''));
      if (orphan) n += 1;
    } else {
      n += 1;
    }
  }
  return n;
}
