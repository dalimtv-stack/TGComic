/**
 * Búsqueda en Comic Vine (JSONP para evitar CORS en el navegador).
 * Requiere VITE_COMICVINE_API_KEY en Vercel / .env
 * https://comicvine.gamespot.com/api/
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
    }, 20000);
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

function parseDateSort(s) {
  const t = String(s || '').trim();
  if (!t) return '9999-99-99';
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  // MM/YYYY
  const m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return m[2] + '-' + m[1].padStart(2, '0') + '-01';
  if (/^\d{4}/.test(t)) return t.slice(0, 4) + '-01-01';
  return '9999-99-99';
}

async function fetchVolumePublisher(apiDetailUrl) {
  if (!apiDetailUrl) return '';
  try {
    const m = String(apiDetailUrl).match(/\/api\/(volume\/[^/?#]+)/i);
    if (!m) return '';
    const path = '/' + m[1].replace(/\/?$/, '/');
    const url = apiUrl(path, { field_list: 'id,name,publisher' });
    const data = await jsonp(url);
    const r = data?.results;
    return r?.publisher?.name || '';
  } catch (_) {
    return '';
  }
}

/**
 * Busca issues; añade editorial (publisher del volume) y ordena por fecha asc.
 */
export async function searchIssues(query, limit = 15) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY en las variables de entorno');
  const q = String(query || '').trim();
  if (!q) return [];
  const url = apiUrl('/search/', {
    query: q,
    resources: 'issue',
    limit: String(limit),
    field_list: 'id,name,issue_number,volume,cover_date,site_detail_url,image,api_detail_url',
  });
  const data = await jsonp(url);
  if (data?.error && data.error !== 'OK') {
    throw new Error('Comic Vine: ' + data.error);
  }
  const results = Array.isArray(data?.results) ? data.results : [];
  const mapped = results.map((r) => ({
    id: r.id,
    name: r.name || '',
    issueNumber: r.issue_number != null ? String(r.issue_number) : '',
    volume: r.volume?.name || '',
    volumeApi: r.volume?.api_detail_url || '',
    coverDate: r.cover_date || '',
    publisher: '',
    siteUrl: r.site_detail_url || '',
    image: r.image?.thumb_url || r.image?.small_url || r.image?.icon_url || '',
    apiDetailUrl: r.api_detail_url || '',
  }));

  // Editoriales por volume (únicos, en paralelo)
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

  mapped.sort((a, b) => parseDateSort(a.coverDate).localeCompare(parseDateSort(b.coverDate)));
  return mapped;
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

export function buildSearchQuery({ series, number, title, fileName }) {
  const parts = [];
  if (series) parts.push(series);
  if (number) parts.push(String(number).replace(/^#/, ''));
  else if (title) parts.push(title);
  if (!parts.length && fileName) {
    parts.push(String(fileName).replace(/\.cb[zr]$/i, '').replace(/_/g, ' '));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
