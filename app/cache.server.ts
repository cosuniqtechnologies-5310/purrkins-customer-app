/**
 * Simple in-memory TTL cache for server-side Shopify GraphQL responses.
 * Singleton shared across all requests in the same Node.js process.
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

class AppCache {
  private store = new Map<string, CacheEntry>();
  private maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    if (this.store.size >= this.maxEntries) {
      const toRemove = Math.floor(this.maxEntries * 0.1);
      let removed = 0;
      for (const k of this.store.keys()) {
        this.store.delete(k);
        removed++;
        if (removed >= toRemove) break;
      }
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  delPrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  flush(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export const appCache = new AppCache(500);
