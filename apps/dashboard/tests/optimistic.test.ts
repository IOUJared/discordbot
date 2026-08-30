import { describe, expect, it } from "vitest"

import { optimisticReorder } from "../src/lib/services/optimistic.js"

describe("optimistic reorder", () => {
  it("Given a stale version When reorder conflicts Then previous rows are restored and state refetched", async () => {
    const seen: string[][] = []
    let refetched = false
    const result = await optimisticReorder(
      ["a", "b"],
      0,
      1,
      (rows) => seen.push([...rows]),
      async () => ({ ok: false, status: 409 }),
      async () => {
        refetched = true
      },
    )
    expect(result).toBe("rolled-back")
    expect(seen).toEqual([
      ["b", "a"],
      ["a", "b"],
    ])
    expect(refetched).toBe(true)
  })
})
