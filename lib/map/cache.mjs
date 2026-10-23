// Per-layer TTL cache for the map layer pack. One in-flight producer per key; serves the last good
// value while a refresh fails (status 'stale') so a flaky upstream never blanks a layer.
export class LayerCache {
  constructor({ ttlMs = 60_000, maxKeys = 64 } = {}) {
    this.ttlMs = ttlMs; this.maxKeys = maxKeys;
    this.entries = new Map(); // key -> { value, fetchedAt, inflight, lastError }
  }

  // Resolves { value, fetchedAt, stale, error }. Throws only when there is no value at all.
  async get(key, producer, { ttlMs = this.ttlMs } = {}) {
    const now = Date.now();
    let e = this.entries.get(key);
    if (e && e.value !== undefined && now - e.fetchedAt < ttlMs) return { value: e.value, fetchedAt: e.fetchedAt, stale: false, error: null };
    if (!e) { e = { value: undefined, fetchedAt: 0, inflight: null, lastError: null }; this.entries.set(key, e); this.evict(); }
    if (!e.inflight) {
      e.inflight = Promise.resolve().then(producer).then(v => { e.value = v; e.fetchedAt = Date.now(); e.lastError = null; return v; })
        .catch(err => { e.lastError = err?.message || String(err); if (e.value === undefined) throw err; return e.value; })
        .finally(() => { e.inflight = null; });
    }
    const value = await e.inflight;
    return { value, fetchedAt: e.fetchedAt, stale: !!e.lastError, error: e.lastError };
  }

  set(key, value) { this.entries.set(key, { value, fetchedAt: Date.now(), inflight: null, lastError: null }); this.evict(); }
  peek(key) { return this.entries.get(key)?.value; }
  clear() { this.entries.clear(); }
  evict() { while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value); }
}
