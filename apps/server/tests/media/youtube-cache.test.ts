import { describe, expect, it } from "vitest"

import { BoundedTtlCache, canonicalizeSearchQuery } from "../../src/media/youtube-cache.js"

describe("YouTube bounded TTL cache", () => {
  it("Given a cached value When its TTL boundary arrives Then the entry expires", () => {
    // Given
    let now = 1_000
    const cache = new BoundedTtlCache<string>({ capacity: 2, ttlMs: 100, now: () => now })
    cache.set("song", "result")

    // When
    now = 1_100

    // Then
    expect(cache.get("song")).toBeUndefined()
  })

  it("Given a full cache When a new key is stored Then the oldest key is evicted", () => {
    // Given
    const cache = new BoundedTtlCache<string>({ capacity: 2, ttlMs: 100, now: () => 1_000 })
    cache.set("first", "one")
    cache.set("second", "two")

    // When
    cache.set("third", "three")

    // Then
    expect(cache.get("first")).toBeUndefined()
    expect(cache.get("second")).toBe("two")
    expect(cache.get("third")).toBe("three")
  })

  it("Given an existing key When it is replaced Then unrelated entries remain", () => {
    // Given
    const cache = new BoundedTtlCache<string>({ capacity: 2, ttlMs: 100, now: () => 1_000 })
    cache.set("first", "old")
    cache.set("second", "two")

    // When
    cache.set("first", "new")

    // Then
    expect(cache.get("first")).toBe("new")
    expect(cache.get("second")).toBe("two")
  })
})

describe("YouTube search query canonicalization", () => {
  it("Given equivalent Unicode, width, case, and whitespace When keyed Then one value is produced", () => {
    // Given
    const variants = ["  CAFÉ\tＤＡＦＴ  ", "cafe\u0301 daft", "CAFÉ\nDaft"]

    // When
    const keys = variants.map(canonicalizeSearchQuery)

    // Then
    expect(new Set(keys)).toEqual(new Set(["café daft"]))
  })
})
