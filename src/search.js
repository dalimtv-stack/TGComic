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

/** Filtra el índice (AND de palabras). */
export function filterSearchIndex(index, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const parts = q.split(/\s+/).filter(Boolean);
  return (index || []).filter((item) => {
    const t = item.searchText || item.label?.toLowerCase() || '';
    return parts.every((p) => t.includes(p));
  });
}
