/**
 * Caché de páginas de cómics en IndexedDB (kv).
 * Clave: pc:{chId}:{msgId}:{pageIndex} → Blob
 * Índice: pc:index → [{ key, size, at, chId, msgId, page }]
 * Límite configurable (pref pageCacheMaxMB, default 500).
 * touch() actualiza en memoria y vuelca con debounce (evita carreras).
 */
export function createPageCache({ kv, pref }) {
  const INDEX = 'pc:index';
  const PREFIX = 'pc:';
  const TOUCH_MS = 450;

  /** @type {Array|null} */
  let memIndex = null;
  let flushTimer = null;
  let flushChain = Promise.resolve();

  function maxBytes() {
    const mb = Math.max(50, Math.min(4000, +(pref('pageCacheMaxMB', '500') || 500)));
    return mb * 1024 * 1024;
  }

  async function readIndex() {
    try {
      const raw = await kv.get(INDEX);
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  async function writeIndex(list) {
    try { await kv.set(INDEX, list); } catch (_) {}
  }

  async function ensureIndex() {
    if (!memIndex) memIndex = await readIndex();
    return memIndex;
  }

  function invalidateMem() {
    memIndex = null;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushChain = flushChain.then(async () => {
        if (!memIndex) return;
        const snapshot = memIndex.slice();
        await writeIndex(snapshot);
      }).catch(() => {});
    }, TOUCH_MS);
  }

  async function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushChain;
    if (memIndex) await writeIndex(memIndex.slice());
  }

  function pageKey(chId, msgId, page) {
    return `${PREFIX}${chId}:${msgId}:${page}`;
  }

  async function get(chId, msgId, page) {
    if (chId == null || msgId == null || page < 0) return null;
    const key = pageKey(chId, msgId, page);
    try {
      const b = await kv.get(key);
      if (b instanceof Blob && b.size) {
        touch(key).catch(() => {});
        return b;
      }
    } catch (_) {}
    return null;
  }

  async function touch(key) {
    const idx = await ensureIndex();
    const i = idx.findIndex((x) => x.key === key);
    if (i < 0) return;
    idx[i].at = Date.now();
    const [row] = idx.splice(i, 1);
    idx.push(row);
    scheduleFlush();
  }

  async function set(chId, msgId, page, blob) {
    if (!blob || !blob.size || chId == null || msgId == null || page < 0) return;
    const key = pageKey(chId, msgId, page);
    const size = blob.size;
    try {
      await kv.set(key, blob);
    } catch (e) {
      console.warn('[pageCache] set', e);
      await evictUntil(size + 1024 * 1024);
      try { await kv.set(key, blob); } catch (e2) {
        console.warn('[pageCache] set retry', e2);
        return;
      }
    }
    const idx = await ensureIndex();
    const filtered = idx.filter((x) => x.key !== key);
    filtered.push({ key, size, at: Date.now(), chId: String(chId), msgId: String(msgId), page });
    memIndex = filtered;
    await flushNow();
    await evictUntil(0);
  }

  async function totalBytes() {
    const idx = await ensureIndex();
    return idx.reduce((s, x) => s + (x.size || 0), 0);
  }

  async function count() {
    return (await ensureIndex()).length;
  }

  async function evictUntil(extra = 0) {
    const limit = maxBytes();
    let idx = await ensureIndex();
    let total = idx.reduce((s, x) => s + (x.size || 0), 0) + extra;
    idx = idx.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
    while (total > limit && idx.length) {
      const row = idx.shift();
      total -= row.size || 0;
      try { await kv.del(row.key); } catch (_) {
        try { await kv.set(row.key, undefined); } catch (_) {}
      }
    }
    memIndex = idx;
    await flushNow();
  }

  async function clearAll() {
    await flushNow();
    const idx = await ensureIndex();
    for (const row of idx) {
      try { await kv.del(row.key); } catch (_) {}
    }
    memIndex = [];
    await writeIndex([]);
  }

  /** Borra páginas cacheadas de un cómic concreto (p.ej. archivo resubido con otro tamaño). */
  async function clearComic(chId, msgId) {
    if (chId == null || msgId == null) return 0;
    await flushNow();
    const idx = await ensureIndex();
    const keep = [];
    let n = 0;
    const cs = String(chId);
    const ms = String(msgId);
    for (const row of idx) {
      if (String(row.chId) === cs && String(row.msgId) === ms) {
        try { await kv.del(row.key); } catch (_) {}
        n++;
      } else keep.push(row);
    }
    memIndex = keep;
    await writeIndex(keep);
    return n;
  }

  async function stats() {
    const idx = await ensureIndex();
    const bytes = idx.reduce((s, x) => s + (x.size || 0), 0);
    return {
      bytes,
      count: idx.length,
      limitBytes: maxBytes(),
      limitMB: Math.round(maxBytes() / (1024 * 1024)),
    };
  }

  return { get, set, totalBytes, count, clearAll, clearComic, stats, maxBytes, pageKey };
}
