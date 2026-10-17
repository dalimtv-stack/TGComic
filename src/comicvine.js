/**
 * Búsqueda Comic Vine (JSONP).
 * Requiere VITE_COMICVINE_API_KEY
 *
 * Misma cobertura que cuando el resultado salía (aunque fuera penúltimo):
 *  - varias /search/ de issues
 *  - varias /search/ de volumes
 *  - /issues/?filter=volume:ID (y 4050-ID)
 * Solo se ordena al final; no se elimina ningún resultado encontrado.
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
    }, 30000);
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

function volumeDetailUrl(volume) {
  if (!volume) return '';
  if (volume.api_detail_url) return volume.api_detail_url;
  const id = volume.id != null ? String(volume.id).replace(/^4050-/, '') : '';
  if (!id) return '';
  return BASE + '/volume/4050-' + id + '/';
}

function mapIssue(r) {
  const vol = r.volume || {};
  const volumeId = vol.id != null ? vol.id : null;
  return {
    id: r.id,
    name: r.name || '',
    issueNumber: r.issue_number != null ? String(r.issue_number) : '',
    volume: vol.name || '',
    volumeApi: volumeDetailUrl(vol),
    volumeId,
    coverDate: r.cover_date || '',
    publisher: r.publisher?.name || vol.publisher?.name || '',
    siteUrl: r.site_detail_url || '',
    image: r.image?.thumb_url || r.image?.small_url || r.image?.icon_url || '',
    apiDetailUrl: r.api_detail_url || '',
  };
}

async function fetchVolumePublisher(apiDetailUrlOrId) {
  if (apiDetailUrlOrId == null || apiDetailUrlOrId === '') return '';
  try {
    let path = '';
    const s = String(apiDetailUrlOrId);
    if (/^https?:\/\//i.test(s)) {
      const m = s.match(/\/api\/(volume\/[^/?#]+)/i);
      path = m ? '/' + m[1].replace(/\/?$/, '/') : '';
    } else if (/volume\//i.test(s)) {
      path = '/' + s.replace(/^\/?api\/?/i, '').replace(/\/?$/, '/') ;
    } else {
      const id = s.replace(/^4050-/, '');
      path = '/volume/4050-' + id + '/';
    }
    if (!path) return '';
    const url = apiUrl(path, { field_list: 'id,name,publisher' });
    const data = await jsonp(url);
    return data?.results?.publisher?.name || '';
  } catch (_) {
    return '';
  }
}


async function attachPublishers(mapped) {
  const volMap = new Map(); // key → publisher name
  const keys = [];
  for (const r of mapped) {
    const key = r.volumeApi || (r.volumeId != null ? String(r.volumeId) : '');
    if (!key || volMap.has(key)) continue;
    volMap.set(key, '');
    keys.push(key);
  }
  await Promise.all(keys.map(async (key) => {
    volMap.set(key, await fetchVolumePublisher(key));
  }));
  for (const r of mapped) {
    if (r.publisher) continue;
    const key = r.volumeApi || (r.volumeId != null ? String(r.volumeId) : '');
    if (key) r.publisher = volMap.get(key) || '';
  }
  return mapped;
}

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
 * Lista issues de un volume.
 * 1) Intenta filter volume:ID
 * 2) Si vacío, volume:4050-ID
 * No filtra por número aquí (la API falla a menudo); el número solo ordena fuera.
 */
export async function listIssuesForVolume(volumeId, issueNumber, limit = 100) {
  if (!API_KEY) throw new Error('Falta VITE_COMICVINE_API_KEY');
  const vid = String(volumeId || '').replace(/^4050-/, '').trim();
  if (!vid) return [];

  async function fetchByFilter(filterVal) {
    const url = apiUrl('/issues/', {
      filter: filterVal,
      limit: String(Math.min(100, limit)),
      offset: '0',
      field_list: 'id,name,issue_number,volume,cover_date,site_detail_url,image,api_detail_url',
      sort: 'cover_date:asc',
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
  const stripped = s.replace(/^0+/, '');
  return stripped || s;
}

/**
 * Cobertura amplia (la que encontraba el cómic) + ranking al final.
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

  // —— 1) Issues /search/ (como cuando sí salía) ——
  const issueQueries = [];
  if (query) issueQueries.push(query);
  if (series) issueQueries.push(series);
  if (series && number) {
    issueQueries.push(series + ' ' + number);
    issueQueries.push(series + ' #' + number);
    issueQueries.push(number + ' ' + series);
  }
  if (query && series && query.toLowerCase() !== series.toLowerCase()) {
    issueQueries.push(query.replace(/\s*-\s*/g, ' '));
  }
  const uniqIssueQ = [...new Set(issueQueries.map((s) => s.trim()).filter(Boolean))];
  // Paralelo pero todas las queries (hasta 6)
  const issueBatches = await Promise.all(
    uniqIssueQ.slice(0, 6).map((q) => searchIssues(q, 30).catch(() => []))
  );
  for (const b of issueBatches) add(b);

  // —— 2) Volumes /search/ + /issues/ por volume ——
  const volQueries = [];
  if (series) volQueries.push(series);
  if (query) {
    const qNoNum = query
      .replace(/#?\s*\d+[a-z]?\s*$/i, '')
      .replace(/\s*-\s*/g, ' ')
      .trim();
    if (qNoNum) volQueries.push(qNoNum);
    volQueries.push(query.replace(/\s*-\s*/g, ' ').trim());
  }
  for (const base of [...volQueries]) {
    if (!base) continue;
    if (base.includes('-')) volQueries.push(base.replace(/\s*-\s*/g, ' ').trim());
    const parts = base.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      volQueries.push(parts[parts.length - 1]);
      volQueries.push(parts.join(' '));
      // "Crossed Badlands" → también "Crossed: Badlands"
      if (parts.length === 2) volQueries.push(parts[0] + ': ' + parts[1]);
    }
  }
  const uniqVolQ = [...new Set(volQueries.map((s) => s.trim()).filter(Boolean))];

  const volLists = await Promise.all(
    uniqVolQ.slice(0, 6).map((vq) => searchVolumes(vq, 10).catch(() => []))
  );
  const vols = [];
  const seenV = new Set();
  for (const list of volLists) {
    for (const v of list) {
      if (v.id == null || seenV.has(v.id)) continue;
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
      if (x.endsWith(serLow)) return 1;
      return 2;
    };
    return score(a.name) - score(b.name);
  });

  // Misma cobertura de antes: varios volúmenes, TODOS sus issues
  // (antes el cómic salía; no limitar a 2)
  const topVols = vols.slice(0, 8);
  const issueLists = await Promise.all(
    topVols.map(async (v) => {
      const list = await listIssuesForVolume(v.id, null, 100).catch(() => []);
      // El search de volume ya trae publisher: reutilizarlo
      for (const i of list) {
        if (!i.publisher && v.publisher) i.publisher = v.publisher;
        if (!i.volumeApi && v.apiDetailUrl) i.volumeApi = v.apiDetailUrl;
        if (i.volumeId == null && v.id != null) i.volumeId = v.id;
        if (!i.volume && v.name) i.volume = v.name;
      }
      return list;
    })
  );
  for (const list of issueLists) add(list);

  // —— Ranking SOLO ordena; no borra ——
  const scoreOf = (r) => {
    let s = 0;
    const nNorm = normNum(r.issueNumber);
    if (numNorm && nNorm === numNorm) s += 100;
    else if (number && String(r.issueNumber || '').toLowerCase() === number.toLowerCase()) s += 100;
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

  // Editorial en cada resultado (por volume, en paralelo)
  const limited = out.slice(0, 80);
  await attachPublishers(limited);
  return limited;
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
