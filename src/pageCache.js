/**
 * Caché de páginas de cómics en IndexedDB (kv).
 * Clave: pc:{chId}:{msgId}:{pageIndex} → Blob
 * Índice: pc:index → [{ key, size, at, chId, msgId, page }]
 * Límite configurable (pref pageCacheMaxMB, default 500).
 */
export function createPageCache({ kv, pref }) {
  const INDEX = 'pc:index';
  const PREFIX = 'pc:';

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
    const idx = await readIndex();
    const i = idx.findIndex((x) => x.key === key);
    if (i >= 0) {
      idx[i].at = Date.now();
      const [row] = idx.splice(i, 1);
      idx.push(row);
      await writeIndex(idx);
    }
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
    let idx = await readIndex();
    idx = idx.filter((x) => x.key !== key);
    idx.push({ key, size, at: Date.now(), chId: String(chId), msgId: String(msgId), page });
    await writeIndex(idx);
    await evictUntil(0);
  }

  async function totalBytes() {
    const idx = await readIndex();
    return idx.reduce((s, x) => s + (x.size || 0), 0);
  }

  async function count() {
    return (await readIndex()).length;
  }

  async function evictUntil(extra = 0) {
    const limit = maxBytes();
    let idx = await readIndex();
    let total = idx.reduce((s, x) => s + (x.size || 0), 0) + extra;
    // LRU: primero los más antiguos (al inicio)
    idx.sort((a, b) => (a.at || 0) - (b.at || 0));
    while (total > limit && idx.length) {
      const row = idx.shift();
      total -= row.size || 0;
      try { await kv.del(row.key); } catch (_) {
        try { await kv.set(row.key, undefined); } catch (_) {}
      }
    }
    await writeIndex(idx);
  }

  async function clearAll() {
    const idx = await readIndex();
    for (const row of idx) {
      try { await kv.del(row.key); } catch (_) {}
    }
    await writeIndex([]);
  }

  async function stats() {
    const idx = await readIndex();
    const bytes = idx.reduce((s, x) => s + (x.size || 0), 0);
    return {
      bytes,
      count: idx.length,
      limitBytes: maxBytes(),
      limitMB: Math.round(maxBytes() / (1024 * 1024)),
    };
  }

  return { get, set, totalBytes, count, clearAll, stats, maxBytes, pageKey };
}
