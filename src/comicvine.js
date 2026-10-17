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
 * Lista issues de un volume.
 * Estrategia fiable: listar por volume (sin filter de número) y filtrar el número en cliente.
 * Prueba volume:ID y volume:4050-ID (CV a veces exige uno u otro).
 */
export async function listIssuesForVolume(volumeId, issueNumber, limit = 100) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY');
  const raw = String(volumeId || '').trim();
  const vid = raw.replace(/^4050-/, '');
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
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map(mapIssue);
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

  const num = String(issueNumber || '').replace(/^#/, '').trim();
  if (!num) return results;

  const numNorm = num.replace(/^0+/, '') || num;
  const numLow = num.toLowerCase();
  const matched = results.filter((i) => {
    const n = String(i.issueNumber || '').trim();
    const nNorm = n.replace(/^0+/, '') || n;
    if (n.toLowerCase() === numLow) return true;
    if (nNorm.toLowerCase() === numNorm.toLowerCase()) return true;
    // Annual / Special
    if (/^[a-z]/i.test(num) && n.toLowerCase().includes(numLow)) return true;
    return false;
  });
  // Si el número no aparece en la primera página, devolver igual el listado
  // (el usuario puede elegir) — si había número y hay match, solo matches
  return matched.length ? matched : (num ? [] : results);
}

/**
 * Búsqueda rápida: pocas llamadas + ranking (número y serie al principio).
 */
export async function searchIssuesSmart(opts = {}) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY en las variables de entorno');
  const query = String(opts.query || '').trim();
  const series = String(opts.series || '').trim();
  const number = String(opts.number || '').replace(/^#/, '').trim();
  const numNorm = (number.replace(/^0+/, '') || number).toLowerCase();

  const seen = new Set();
  const out = [];
  const add = (arr) => {
    for (const r of arr || []) {
      if (r.id == null || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  };

  // --- 1) Una sola búsqueda de issues (serie + número, sin canal) ---
  const issueQuery = [series, number].filter(Boolean).join(' ')
    || query
    || '';
  if (issueQuery) {
    add(await searchIssues(issueQuery, 20).catch(() => []));
  }

  // --- 2) Volumen → issues (máx. 2 queries de volumen, 2 volúmenes) ---
  const volQ = [];
  if (series) volQ.push(series);
  if (query) {
    const qNoNum = query.replace(/#?\s*\d+[a-z]?\s*$/i, '').replace(/\s*-\s*/g, ' ').trim();
    if (qNoNum && qNoNum.toLowerCase() !== series.toLowerCase()) volQ.push(qNoNum);
  }
  // Última palabra (Badlands)
  for (const b of [...volQ]) {
    const parts = b.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) volQ.push(parts[parts.length - 1]);
  }
  const uniqVolQ = [...new Set(volQ.map((s) => s.trim()).filter(Boolean))].slice(0, 2);

  const volLists = await Promise.all(uniqVolQ.map((vq) => searchVolumes(vq, 5).catch(() => [])));
  const vols = [];
  const seenV = new Set();
  for (const list of volLists) {
    for (const v of list) {
      if (seenV.has(v.id)) continue;
      seenV.add(v.id);
      vols.push(v);
    }
  }
  const serLow = (series || uniqVolQ[0] || '').toLowerCase();
  vols.sort((a, b) => {
    const score = (n) => {
      const x = (n || '').toLowerCase();
      if (!serLow) return 2;
      if (x === serLow) return 0;
      if (x.includes(serLow) || serLow.includes(x)) return 1;
      return 2;
    };
    return score(a.name) - score(b.name);
  });

  for (const v of vols.slice(0, 2)) {
    try {
      const issues = await listIssuesForVolume(v.id, number, 80);
      add(issues);
    } catch (_) {}
  }

  // Ranking: número exacto primero, luego volumen ≈ serie
  const scoreOf = (r) => {
    let s = 0;
    const n = String(r.issueNumber || '').trim();
    const nNorm = (n.replace(/^0+/, '') || n).toLowerCase();
    if (number) {
      if (n.toLowerCase() === number.toLowerCase() || nNorm === numNorm) s += 100;
      else if (nNorm && numNorm && nNorm.startsWith(numNorm)) s += 40;
    }
    const vol = String(r.volume || '').toLowerCase();
    if (serLow) {
      if (vol === serLow) s += 50;
      else if (vol.includes(serLow) || serLow.includes(vol)) s += 25;
    }
    return s;
  };
  out.sort((a, b) => scoreOf(b) - scoreOf(a));

  // Sin editoriales en listado (rápido); se cargan al elegir ficha
  return out.slice(0, 20);
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
    // Roles de portada no van a dibujante interior
    if (/(^|\b)cover(\b|$)/.test(role) && !/penciler|penciller|inker/.test(role.replace(/cover/g, ''))) {
      // "cover artist", "cover" → ignorar para dibujante
      if (/writer|script/.test(role)) writers.push(n);
      continue;
    }
    if (/writer|script/.test(role)) writers.push(n);
    // Inglés CV: penciler, penciller, artist, inker
    if (/penciler|penciller/.test(role)) pencilers.push(n);
    else if (/(^|\b)artist(\b|$)/.test(role) && !/colorist|letterer|inker/.test(role)) artists.push(n);
    else if (/inker/.test(role)) inkers.push(n);
  }
  // Preferir penciler > artist > inker
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
