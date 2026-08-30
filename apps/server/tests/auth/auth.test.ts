import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { OAuthStateStore } from "../../src/auth/oauth-state.js"

describe("OAuth state", () => {
  it("Given a new state When it is consumed Then it is accepted exactly once", () => {
    const store = new OAuthStateStore(
      () => 1_000,
      () => "random",
    )
    const issued = store.issue()

    expect(store.consume(issued.state)).toEqual({ kind: "accepted", verifier: "random" })
    expect(store.consume(issued.state)).toEqual({ kind: "rejected" })
  })

  it("Given an issued verifier When PKCE is generated Then the challenge is SHA-256 URL-safe", () => {
    const store = new OAuthStateStore(
      () => 1_000,
      () => "verifier",
    )
    const issued = store.issue()
    const expected = createHash("sha256").update("verifier").digest("base64url")

    expect(issued.challenge).toBe(expected)
  })

  it("Given expired state When it is consumed Then it is rejected", () => {
    let now = 1_000
    const store = new OAuthStateStore(
      () => now,
      () => "random",
      60_000,
    )
    const issued = store.issue()
    now = 61_001

    expect(store.consume(issued.state)).toEqual({ kind: "rejected" })
  })
})
