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

/**
 * Busca issues por texto libre.
 * @returns {Promise<Array<{id,name,issueNumber,volume,coverDate,pageCount,siteUrl,image}>>}
 */
export async function searchIssues(query, limit = 15) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY en las variables de entorno');
  const q = String(query || '').trim();
  if (!q) return [];
  const url = apiUrl('/search/', {
    query: q,
    resources: 'issue',
    limit: String(limit),
    field_list: 'id,name,issue_number,volume,cover_date,page_count,site_detail_url,image,api_detail_url',
  });
  const data = await jsonp(url);
  if (data?.error && data.error !== 'OK') {
    throw new Error('Comic Vine: ' + data.error);
  }
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((r) => ({
    id: r.id,
    name: r.name || '',
    issueNumber: r.issue_number != null ? String(r.issue_number) : '',
    volume: r.volume?.name || '',
    coverDate: r.cover_date || '',
    pageCount: r.page_count != null && r.page_count !== '' ? Number(r.page_count) : null,
    siteUrl: r.site_detail_url || '',
    image: r.image?.thumb_url || r.image?.small_url || r.image?.icon_url || '',
    apiDetailUrl: r.api_detail_url || '',
  }));
}

/**
 * Detalle de un issue (créditos, descripción, páginas…).
 */
export async function fetchIssueDetail(apiDetailUrlOrId) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY');
  let path;
  const s = String(apiDetailUrlOrId || '');
  if (/^https?:\/\//i.test(s)) {
    // https://comicvine.gamespot.com/api/issue/4000-12345/
    const m = s.match(/\/api\/(issue\/[^/?#]+)/i);
    path = m ? '/' + m[1].replace(/\/?$/, '/') : null;
  } else {
    path = '/issue/4000-' + String(s).replace(/^4000-/, '') + '/';
  }
  if (!path) throw new Error('URL de detalle no válida');
  const url = apiUrl(path, {
    field_list: 'id,name,issue_number,volume,cover_date,page_count,description,person_credits,site_detail_url,image',
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
    if (/artist|penciler|penciller|inker|cover/.test(role) && !/cover/.test(role)) artists.push(n);
    else if (/artist|penciler|penciller|inker/.test(role)) artists.push(n);
  }
  // description HTML → texto plano breve
  let desc = String(r.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (desc.length > 1200) desc = desc.slice(0, 1200) + '…';
  let date = r.cover_date || '';
  // YYYY-MM-DD → MM/YYYY o YYYY
  const dm = String(date).match(/^(\d{4})-(\d{2})/);
  if (dm) date = dm[2] + '/' + dm[1];
  else if (/^\d{4}/.test(date)) date = date.slice(0, 4);

  return {
    id: r.id,
    name: r.name || '',
    issueNumber: r.issue_number != null ? String(r.issue_number) : '',
    volume: r.volume?.name || '',
    coverDate: date,
    pageCount: r.page_count != null && r.page_count !== '' ? Number(r.page_count) : null,
    description: desc,
    writers: [...new Set(writers)],
    artists: [...new Set(artists)],
    siteUrl: r.site_detail_url || '',
  };
}

/** Query sugerida a partir de serie + número + título */
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
