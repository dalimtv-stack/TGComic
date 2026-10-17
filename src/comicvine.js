/**
 * Búsqueda en Comic Vine (JSONP).
 * Requiere VITE_COMICVINE_API_KEY
 *
 * Estrategia: /search/ issues + /search/ volumes → /issues/?filter=volume:ID
 * Listamos issues del volumen SIN filtrar por número en la API (poco fiable);
 * el número solo sirve para ordenar el listado.
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
  return (Array.isArray(data?.results) ? data.results : []).map(mapIssue);
}

/** Busca volúmenes por nombre */
export async function searchVolumes(query, limit = 10) {
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
  return (Array.isArray(data?.results) ? data.results : []).map((r) => ({
    id: r.id,
    name: r.name || '',
    apiDetailUrl: r.api_detail_url || '',
    publisher: r.publisher?.name || '',
    startYear: r.start_year || '',
    count: r.count_of_issues,
  }));
}

/**
 * Todos los issues de un volume (sin filtrar por número en la API).
 * Prueba volume:ID y volume:4050-ID.
 */
export async function listIssuesForVolume(volumeId, _issueNumber, limit = 100) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY');
  const vid = String(volumeId || '').replace(/^4050-/, '').trim();
  if (!vid) return [];

  async function fetchByFilter(filterVal) {
    const url = apiUrl('/issues/', {
      filter: filterVal,
      limit: String(Math.min(100, limit)),
      offset: '0',
      field_list: 'id,name,issue_number,volume,cover_date,site_detail_url,image,api_detail_url',
      sort: 'issue_number:asc',
    });
    const data = await jsonp(url);
    if (data?.error && data.error !== 'OK') throw new Error('Comic Vine: ' + data.error);
    return (Array.isArray(data?.results) ? data.results : []).map(mapIssue);
  }

  let results = [];
  try {
    results = await fetchByFilter('volume:' + vid);
  } catch (_) {
    results = [];
  }
  if (!results.length) {
    try {
      results = await fetchByFilter('volume:4050-' + vid);
    } catch (_) {
      results = [];
    }
  }
  return results;
}

function normNum(n) {
  const s = String(n || '').replace(/^#/, '').trim().toLowerCase();
  if (!s) return '';
  return s.replace(/^0+/, '') || s;
}

/**
 * Búsqueda combinada + ranking (el número buscado sale primero, sin excluir el resto).
 */
export async function searchIssuesSmart(opts = {}) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY en las variables de entorno');
  const query = String(opts.query || '').trim();
  const series = String(opts.series || '').trim();
  const number = String(opts.number || '').replace(/^#/, '').trim();
  const numNorm = normNum(number);

  const seen = new Set();
  const out = [];
  const add = (arr) => {
    for (const r of arr || []) {
      if (r.id == null || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  };

  // 1) Búsquedas de issues en paralelo
  const issueQs = new Set();
  if (query) issueQs.add(query);
  if (series) issueQs.add(series);
  if (series && number) {
    issueQs.add(series + ' ' + number);
    issueQs.add(series + ' #' + number);
  }
  if (query && number && !query.includes(number)) {
    issueQs.add(query + ' ' + number);
  }
  const issueBatches = await Promise.all(
    [...issueQs].slice(0, 4).map((q) => searchIssues(q, 25).catch(() => []))
  );
  for (const b of issueBatches) add(b);

  // 2) Volúmenes → listar issues (paralelo)
  const volQs = new Set();
  if (series) volQs.add(series);
  if (query) {
    const qNoNum = query
      .replace(/#?\s*\d+[a-z]?\s*$/i, '')
      .replace(/\s*-\s*/g, ' ')
      .trim();
    if (qNoNum) volQs.add(qNoNum);
  }
  for (const b of [...volQs]) {
    const parts = b.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      volQs.add(parts[parts.length - 1]);
      volQs.add(parts.join(' '));
    }
  }

  const volLists = await Promise.all(
    [...volQs].slice(0, 5).map((vq) => searchVolumes(vq, 10).catch(() => []))
  );
  const vols = [];
  const seenV = new Set();
  for (const list of volLists) {
    for (const v of list) {
      if (seenV.has(v.id)) continue;
      seenV.add(v.id);
      vols.push(v);
    }
  }

  const serLow = (series || [...volQs][0] || '').toLowerCase();
  vols.sort((a, b) => {
    const score = (n) => {
      const x = (n || '').toLowerCase();
      if (!serLow) return 2;
      if (x === serLow) return 0;
      if (x.includes(serLow) || serLow.includes(x)) return 1;
      if (x.endsWith(serLow)) return 1;
      return 2;
    };
    return score(a.name) - score(b.name);
  });

  // Hasta 5 volúmenes: listar TODOS sus issues (sin filtrar número en API)
  const issueLists = await Promise.all(
    vols.slice(0, 5).map((v) => listIssuesForVolume(v.id, null, 100).catch(() => []))
  );
  for (const list of issueLists) add(list);

  // Ranking: no se elimina nada; solo se ordena
  const scoreOf = (r) => {
    let s = 0;
    const nNorm = normNum(r.issueNumber);
    if (numNorm) {
      if (nNorm === numNorm) s += 100;
      else if (nNorm && (nNorm === numNorm || String(r.issueNumber).toLowerCase() === number.toLowerCase())) s += 100;
    }
    const vol = String(r.volume || '').toLowerCase();
    if (serLow) {
      if (vol === serLow) s += 50;
      else if (vol.includes(serLow) || serLow.includes(vol)) s += 25;
      else if (vol.endsWith(serLow)) s += 20;
    }
    return s;
  };

  out.sort((a, b) => {
    const d = scoreOf(b) - scoreOf(a);
    if (d) return d;
    return String(a.issueNumber || '').localeCompare(String(b.issueNumber || ''), undefined, { numeric: true });
  });

  // Más resultados en pantalla (antes se cortaba y podía quedar fuera)
  return out.slice(0, 40);
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
  const pencilers = [];
  const artists = [];
  const inkers = [];
  for (const c of credits) {
    const role = String(c.role || '').toLowerCase().trim();
    const n = c.name || '';
    if (!n) continue;
    if (/(^|\b)cover(\b|$)/.test(role) && !/penciler|penciller|inker/.test(role.replace(/cover/g, ''))) {
      if (/writer|script/.test(role)) writers.push(n);
      continue;
    }
    if (/writer|script/.test(role)) writers.push(n);
    if (/penciler|penciller/.test(role)) pencilers.push(n);
    else if (/(^|\b)artist(\b|$)/.test(role) && !/colorist|letterer|inker/.test(role)) artists.push(n);
    else if (/inker/.test(role)) inkers.push(n);
  }
  const artistsFinal = [...new Set([...pencilers, ...artists, ...inkers])];
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
    artists: artistsFinal,
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
