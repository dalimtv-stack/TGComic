/**
 * Búsqueda en Comic Vine (JSONP para evitar CORS en el navegador).
 * Requiere VITE_COMICVINE_API_KEY en Vercel / .env
 * https://comicvine.gamespot.com/api/
 *
 * La búsqueda genérica de CV es peor que la web; combinamos:
 *  - /search/ issues
 *  - /search/ volumes + /issues/?filter=volume:…
 */
const API_KEY = (import.meta.env.VITE_COMICVINE_API_KEY || '').trim();
const BASE = 'https://comicvine.gamespot.com/api';

export function comicVineConfigured() {
  return !!API_KEY;
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = 'cv_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Comic Vine: tiempo de espera agotado'));
    }, 25000);
    const cleanup = () => {
      clearTimeout(timer);
      try { delete window[cb]; } catch (_) { window[cb] = undefined; }
      script.remove();
    };
    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('Comic Vine: error de red'));
    };
    const sep = url.includes('?') ? '&' : '?';
    script.src = url + sep + 'format=jsonp&json_callback=' + cb;
    document.head.appendChild(script);
  });
}

function apiUrl(path, params = {}) {
  const q = new URLSearchParams({ api_key: API_KEY, ...params });
  return BASE + path + (path.includes('?') ? '&' : '?') + q.toString();
}

function mapIssue(r) {
  return {
    id: r.id,
    name: r.name || '',
    issueNumber: r.issue_number != null ? String(r.issue_number) : '',
    volume: r.volume?.name || '',
    volumeApi: r.volume?.api_detail_url || '',
    volumeId: r.volume?.id != null ? r.volume.id : null,
    coverDate: r.cover_date || '',
    publisher: '',
    siteUrl: r.site_detail_url || '',
    image: r.image?.thumb_url || r.image?.small_url || r.image?.icon_url || '',
    apiDetailUrl: r.api_detail_url || '',
  };
}

async function fetchVolumePublisher(apiDetailUrl) {
  if (!apiDetailUrl) return '';
  try {
    const m = String(apiDetailUrl).match(/\/api\/(volume\/[^/?#]+)/i);
    if (!m) return '';
    const path = '/' + m[1].replace(/\/?$/, '/');
    const url = apiUrl(path, { field_list: 'id,name,publisher' });
    const data = await jsonp(url);
    return data?.results?.publisher?.name || '';
  } catch (_) {
    return '';
  }
}

async function attachPublishers(mapped) {
  const volMap = new Map();
  for (const r of mapped) {
    if (r.volumeApi && !volMap.has(r.volumeApi)) volMap.set(r.volumeApi, '');
  }
  await Promise.all([...volMap.keys()].map(async (u) => {
    volMap.set(u, await fetchVolumePublisher(u));
  }));
  for (const r of mapped) {
    r.publisher = (r.volumeApi && volMap.get(r.volumeApi)) || '';
  }
  return mapped;
}

/** Búsqueda libre de issues */
export async function searchIssues(query, limit = 25) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY en las variables de entorno');
  const q = String(query || '').trim();
  if (!q) return [];
  const url = apiUrl('/search/', {
    query: q,
    resources: 'issue',
    limit: String(Math.min(50, limit)),
    field_list: 'id,name,issue_number,volume,cover_date,site_detail_url,image,api_detail_url',
  });
  const data = await jsonp(url);
  if (data?.error && data.error !== 'OK') throw new Error('Comic Vine: ' + data.error);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(mapIssue);
}

/** Busca volúmenes (series) por nombre */
export async function searchVolumes(query, limit = 8) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY');
  const q = String(query || '').trim();
  if (!q) return [];
  const url = apiUrl('/search/', {
    query: q,
    resources: 'volume',
    limit: String(limit),
    field_list: 'id,name,api_detail_url,publisher,start_year,count_of_issues',
  });
  const data = await jsonp(url);
  if (data?.error && data.error !== 'OK') throw new Error('Comic Vine: ' + data.error);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((r) => ({
    id: r.id,
    name: r.name || '',
    apiDetailUrl: r.api_detail_url || '',
    publisher: r.publisher?.name || '',
    startYear: r.start_year || '',
    count: r.count_of_issues,
  }));
}

/**
 * Lista issues de un volume (opcionalmente filtrado por número).
 * volumeId numérico (sin prefijo 4050-).
 */
export async function listIssuesForVolume(volumeId, issueNumber, limit = 30) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY');
  const vid = String(volumeId || '').replace(/^4050-/, '');
  if (!vid) return [];
  const filterParts = [`volume:${vid}`];
  const num = String(issueNumber || '').replace(/^#/, '').trim();
  // Solo filtrar por número si es numérico puro (Annual etc. se listan sin filtro)
  if (num && /^\d+[a-z]?$/i.test(num)) {
    filterParts.push(`issue_number:${num}`);
  }
  const url = apiUrl('/issues/', {
    filter: filterParts.join(','),
    limit: String(Math.min(50, limit)),
    field_list: 'id,name,issue_number,volume,cover_date,site_detail_url,image,api_detail_url',
    sort: 'cover_date:asc',
  });
  const data = await jsonp(url);
  if (data?.error && data.error !== 'OK') throw new Error('Comic Vine: ' + data.error);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(mapIssue);
}

/**
 * Búsqueda combinada (mejor cobertura que un solo /search/).
 * @param {{ query?: string, series?: string, number?: string }} opts
 */
export async function searchIssuesSmart(opts = {}) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY en las variables de entorno');
  const query = String(opts.query || '').trim();
  const series = String(opts.series || '').trim();
  const number = String(opts.number || '').replace(/^#/, '').trim();
  const seen = new Set();
  const out = [];
  const add = (arr) => {
    for (const r of arr || []) {
      const id = r.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      out.push(r);
    }
  };

  const tasks = [];

  // 1) Query tal cual
  if (query) tasks.push(searchIssues(query, 30).catch(() => []));

  // 2) Serie + número (sin canal)
  if (series) {
    const q2 = [series, number].filter(Boolean).join(' ');
    if (q2 && q2.toLowerCase() !== query.toLowerCase()) {
      tasks.push(searchIssues(q2, 30).catch(() => []));
    }
  }

  // 3) Solo número + serie al revés a veces ayuda
  if (series && number) {
    tasks.push(searchIssues(number + ' ' + series, 15).catch(() => []));
  }

  const batches = await Promise.all(tasks);
  for (const b of batches) add(b);

  // 4) Volumen → listado de issues (mucho más fiable que search)
  if (series) {
    try {
      const vols = await searchVolumes(series, 6);
      // Priorizar nombre de volumen más parecido
      const serLow = series.toLowerCase();
      vols.sort((a, b) => {
        const as = a.name.toLowerCase() === serLow ? 0 : a.name.toLowerCase().includes(serLow) ? 1 : 2;
        const bs = b.name.toLowerCase() === serLow ? 0 : b.name.toLowerCase().includes(serLow) ? 1 : 2;
        return as - bs;
      });
      for (const v of vols.slice(0, 4)) {
        try {
          const issues = await listIssuesForVolume(v.id, number, number ? 20 : 25);
          // Si filtramos por número y no hay nada, listar sin filtro y filtrar en cliente
          if (number && !issues.length) {
            const all = await listIssuesForVolume(v.id, '', 40);
            const numLow = number.toLowerCase();
            add(all.filter((i) =>
              String(i.issueNumber || '').toLowerCase() === numLow
              || String(i.issueNumber || '').replace(/^0+/, '') === numLow.replace(/^0+/, '')
              || String(i.name || '').toLowerCase().includes(numLow)
            ));
          } else {
            add(issues);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  await attachPublishers(out);
  return out;
}

export async function fetchIssueDetail(apiDetailUrlOrId) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY');
  let path;
  const s = String(apiDetailUrlOrId || '');
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/\/api\/(issue\/[^/?#]+)/i);
    path = m ? '/' + m[1].replace(/\/?$/, '/') : null;
  } else {
    path = '/issue/4000-' + String(s).replace(/^4000-/, '') + '/';
  }
  if (!path) throw new Error('URL de detalle no válida');
  const url = apiUrl(path, {
    field_list: 'id,name,issue_number,volume,cover_date,description,person_credits,site_detail_url,image',
  });
  const data = await jsonp(url);
  if (data?.error && data.error !== 'OK') throw new Error('Comic Vine: ' + data.error);
  const r = data?.results;
  if (!r) return null;
  const credits = Array.isArray(r.person_credits) ? r.person_credits : [];
  const writers = [];
  const artists = [];
  for (const c of credits) {
    const role = String(c.role || '').toLowerCase();
    const n = c.name || '';
    if (!n) continue;
    if (/writer|script/.test(role)) writers.push(n);
    if (/penciler|penciller|inker|artist/.test(role) && !/cover/.test(role)) artists.push(n);
  }
  let desc = String(r.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (desc.length > 1200) desc = desc.slice(0, 1200) + '…';
  let date = r.cover_date || '';
  const dm = String(date).match(/^(\d{4})-(\d{2})/);
  if (dm) date = dm[2] + '/' + dm[1];
  else if (/^\d{4}/.test(date)) date = date.slice(0, 4);

  let publisher = '';
  try {
    const volApi = r.volume?.api_detail_url;
    if (volApi) publisher = await fetchVolumePublisher(volApi);
  } catch (_) {}

  return {
    id: r.id,
    name: r.name || '',
    issueNumber: r.issue_number != null ? String(r.issue_number) : '',
    volume: r.volume?.name || '',
    coverDate: date,
    publisher,
    description: desc,
    writers: [...new Set(writers)],
    artists: [...new Set(artists)],
    siteUrl: r.site_detail_url || '',
  };
}

export function buildSearchQuery({ channel, series, number, fileName }) {
  const parts = [];
  if (channel) parts.push(String(channel).trim());
  if (series) parts.push(String(series).trim());
  if (number) parts.push(String(number).replace(/^#/, '').trim());
  if (!parts.filter(Boolean).length && fileName) {
    parts.push(String(fileName).replace(/\.cb[zr]$/i, '').replace(/_/g, ' '));
  }
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
