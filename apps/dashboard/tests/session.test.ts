import { describe, expect, it } from "vitest"

import { consumeAuthFragment, createSessionStore } from "../src/lib/services/session.js"

describe("session boundary", () => {
  it("Given callback code When fragment is consumed Then exchange occurs and hash is removed", async () => {
    const location = { hash: "#code=once", pathname: "/remote/", search: "" }
    const history = { replaceState: (_data: unknown, _unused: string, url: string) => url }
    const result = await consumeAuthFragment(location, history, async (code) => ({
      token: `token-${code}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    }))
    expect(result.kind).toBe("authenticated")
    expect(location.hash).toBe("")
  })

  it("Given an expired token When session loads Then storage is cleared", () => {
    const values = new Map([
      [
        "discord-music.session",
        JSON.stringify({ token: "old", expiresAt: "2000-01-01T00:00:00.000Z" }),
      ],
    ])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    expect(
      createSessionStore(storage, () => Date.parse("2026-01-01T00:00:00.000Z")).load(),
    ).toBeNull()
    expect(values.size).toBe(0)
  })
})
