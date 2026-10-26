/**
 * Buscador general (home): indexa editoriales, canales, series y cómics
 * a partir de LIB + caché local de archivos.
 */

/**
 * @param {object} deps
 * @param {Array} deps.LIB
 * @param {(ch: any) => Promise<any[]>} deps.getFiles  // async (ch) => files
 * @param {(name: string) => string} deps.groupDisplayName
 * @param {(ch: any) => string} deps.channelDisplayName
 * @param {(ch: any, label: string) => string} deps.seriesDisplayName
 * @param {(files: any[], channelName: string) => Array<{label: string, files: any[]}>} deps.groupSeries
 * @param {(name: string, channelName: string) => string} deps.comicDisplay
 * @param {(ch: any, f: any, fallback: string) => string} deps.comicDisplayName
 * @param {(ch: any, seriesLabel: string, files: any[]) => void} deps.openSeries
 * @param {(ch: any, f: any) => void} deps.openComic
 * @param {(group: string) => void} deps.openGroup
 * @param {(ch: any) => void} deps.openChannel
 */
export async function buildSearchIndex(deps) {
  const {
    LIB,
    getFiles,
    groupDisplayName,
    channelDisplayName,
    seriesDisplayName,
    groupSeries,
    seriesOverrideFor,
    comicDisplay,
    comicDisplayName,
    openSeries,
    openComic,
    openGroup,
    openChannel,
  } = deps;

  const items = [];
  const seenGroup = new Set();

  for (const ch of LIB || []) {
    const g = ch.group || 'Sin editorial';
    if (!seenGroup.has(g)) {
      seenGroup.add(g);
      const gl = groupDisplayName(g);
      items.push({
        type: 'group',
        typeLabel: 'Editorial',
        label: gl,
        sub: 'Editorial',
        searchText: (gl + ' ' + g).toLowerCase(),
        go: () => openGroup(g),
        group: g,
      });
    }

    const cl = channelDisplayName(ch);
    items.push({
      type: 'channel',
      typeLabel: 'Canal',
      label: cl,
      sub: groupDisplayName(g),
      searchText: (cl + ' ' + (ch.name || '') + ' ' + g).toLowerCase(),
      go: () => openChannel(ch),
      ch,
    });

    let files = [];
    try {
      files = (await getFiles(ch)) || [];
    } catch (_) {
      files = [];
    }

    const override = seriesOverrideFor ? seriesOverrideFor(ch) : undefined;
    for (const { label: seriesLabel, files: fs } of groupSeries(files, ch.name, override)) {
      const seriesShown = seriesDisplayName(ch, seriesLabel);
      if (fs.length > 1) {
        items.push({
          type: 'series',
          typeLabel: 'Serie',
          label: seriesShown,
          sub: cl + ' · ' + fs.length + ' números',
          searchText: (seriesShown + ' ' + seriesLabel + ' ' + cl).toLowerCase(),
          go: () => openSeries(ch, seriesLabel, fs),
          ch,
          seriesLabel,
        });
      }
      for (const f of fs) {
        const base = comicDisplay(f.name, ch.name);
        const title = comicDisplayName(ch, f, base);
        items.push({
          type: 'comic',
          typeLabel: 'Cómic',
          label: title,
          sub: cl + (seriesShown ? ' · ' + seriesShown : ''),
          searchText: (title + ' ' + (f.name || '') + ' ' + seriesLabel + ' ' + cl).toLowerCase(),
          go: () => openComic(ch, f),
          ch,
          f,
        });
      }
    }
  }

  return items;
}

/** Minúsculas y sin acentos/diacríticos ("Acción" → "accion"). */
export function normSearch(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const TYPE_RANK = { series: 0, comic: 1, channel: 2, group: 3 };

/** Filtra el índice (AND de palabras, sin distinguir acentos) y ordena por relevancia. */
export function filterSearchIndex(index, query) {
  const q = normSearch(query).trim();
  if (!q) return [];
  const parts = q.split(/\s+/).filter(Boolean);
  const out = [];
  (index || []).forEach((item, pos) => {
    if (item._norm == null) item._norm = normSearch(item.searchText || item.label || '');
    const t = item._norm;
    if (!parts.every((p) => t.includes(p))) return;
    if (item._normLabel == null) item._normLabel = normSearch(item.label || '');
    const l = item._normLabel;
    // 0: título empieza por la búsqueda · 1: alguna palabra del título empieza así · 2: título la contiene · 3: resto
    let score = 3;
    if (l.startsWith(q)) score = 0;
    else if ((' ' + l).includes(' ' + parts[0])) score = 1;
    else if (l.includes(parts[0])) score = 2;
    out.push({ item, score, pos });
  });
  out.sort((a, b) => a.score - b.score
    || (TYPE_RANK[a.item.type] ?? 9) - (TYPE_RANK[b.item.type] ?? 9)
    || a.pos - b.pos);
  return out.map((x) => x.item);
}
