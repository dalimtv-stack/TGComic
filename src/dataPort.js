/**
 * Importar / exportar renombres, desagrupaciones y portadas custom (JSON).
 */
const LS_PREFIXES = [
  'ungroup:', 'seriesName:', 'comicName:', 'comicSeries:', 'coverFit:',
];
const LS_KEYS_EXACT = ['channelNames', 'groupNames', 'contentLocks'];
// Nunca se exportan ni se importan (sesión de Telegram y credenciales de sincronización)
const isPrivateKey = (k) => k === 'tg_session' || k.startsWith('sync:');

function lsKeysOfInterest() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || isPrivateKey(k)) continue;
      if (LS_KEYS_EXACT.includes(k) || LS_PREFIXES.some((p) => k.startsWith(p))) out.push(k);
      // meta.js keys
      if (/^(ug:|sn:|cn:|gn:|chn:|cov:)/.test(k)) out.push(k);
    }
  } catch (_) {}
  return [...new Set(out)];
}

export async function exportLibraryData({ kv, includeCovers = true }) {
  const local = {};
  for (const k of lsKeysOfInterest()) {
    try { local[k] = localStorage.getItem(k); } catch (_) {}
  }
  // Also common rename keys used in project
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (/rename|ungroup|display|override/i.test(k) && !(k in local) && !isPrivateKey(k)) {
        local[k] = localStorage.getItem(k);
      }
    }
  } catch (_) {}

  const covers = {};
  if (includeCovers && kv) {
    try {
      const entries = await kv.entries();
      for (const [k, v] of entries) {
        if (typeof k !== 'string') continue;
        // custom covers / comic covers / art overrides
        if (!(k.startsWith('c:') || k.startsWith('art:') || k.startsWith('gcov:') || k.startsWith('ccov:'))) continue;
        if (!(v instanceof Blob)) continue;
        if (v.size > 800 * 1024) continue; // skip very large
        const buf = await v.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        covers[k] = {
          type: v.type || 'image/jpeg',
          b64: btoa(bin),
        };
      }
    } catch (e) {
      console.warn('[dataPort] covers', e);
    }
  }

  return {
    v: 1,
    exportedAt: new Date().toISOString(),
    localStorage: local,
    covers,
  };
}

export async function importLibraryData(data, { kv } = {}) {
  if (!data || typeof data !== 'object') throw new Error('JSON inválido');
  const local = data.localStorage || data.keys || {};
  let nLs = 0;
  for (const [k, v] of Object.entries(local)) {
    if (!k || isPrivateKey(k)) continue;
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, String(v));
      nLs++;
    } catch (_) {}
  }
  let nCov = 0;
  const covers = data.covers || {};
  if (kv && covers && typeof covers === 'object') {
    for (const [k, meta] of Object.entries(covers)) {
      try {
        const b64 = meta.b64 || meta.data;
        if (!b64) continue;
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const blob = new Blob([u8], { type: meta.type || 'image/jpeg' });
        await kv.set(k, blob);
        nCov++;
      } catch (e) {
        console.warn('[dataPort] cover', k, e);
      }
    }
  }
  return { localStorage: nLs, covers: nCov };
}

export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `tgcomic-data-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
