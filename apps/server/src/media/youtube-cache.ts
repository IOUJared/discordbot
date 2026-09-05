type CacheOptions = {
  readonly capacity: number
  readonly ttlMs: number
  readonly now: () => number
}

type CacheEntry<Value> = {
  readonly expiresAt: number
  readonly value: Value
}

export class BoundedTtlCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>()

  constructor(private readonly options: CacheOptions) {}

  get(key: string): Value | undefined {
    const entry = this.entries.get(key)
    if (entry !== undefined && entry.expiresAt > this.options.now()) return entry.value
    this.entries.delete(key)
    return undefined
  }

  set(key: string, value: Value): void {
    this.entries.delete(key)
    if (this.entries.size >= this.options.capacity) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { expiresAt: this.options.now() + this.options.ttlMs, value })
  }
}

export function canonicalizeSearchQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()
}
