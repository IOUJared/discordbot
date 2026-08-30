import { createHash } from "node:crypto"

type StateEntry = { readonly verifier: string; readonly expiresAtMs: number }
type ConsumeResult =
  | { readonly kind: "accepted"; readonly verifier: string }
  | { readonly kind: "rejected" }

export class OAuthStateStore {
  private readonly entries = new Map<string, StateEntry>()

  constructor(
    private readonly now: () => number,
    private readonly randomToken: () => string,
    private readonly lifetimeMs = 5 * 60_000,
  ) {}

  issue(): { readonly state: string; readonly verifier: string; readonly challenge: string } {
    const state = this.randomToken()
    const verifier = this.randomToken()
    this.entries.set(hash(state), { verifier, expiresAtMs: this.now() + this.lifetimeMs })
    return {
      state,
      verifier,
      challenge: createHash("sha256").update(verifier, "utf8").digest("base64url"),
    }
  }

  consume(state: string): ConsumeResult {
    const key = hash(state)
    const entry = this.entries.get(key)
    this.entries.delete(key)
    if (entry === undefined || entry.expiresAtMs <= this.now()) return { kind: "rejected" }
    return { kind: "accepted", verifier: entry.verifier }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}
