import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { openPersistence } from "../../src/db/index.js"
import { FixedClock, SequenceRandom, USER_ID } from "./fixtures.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "discord-music-auth-"))
  directories.push(directory)
  return join(directory, "server.sqlite")
}

describe("temporary authentication persistence", () => {
  it("consumes an OAuth exchange code exactly once", async () => {
    // Given
    const persistence = openPersistence({
      path: await databasePath(),
      clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
      random: new SequenceRandom(["exchange-secret"]),
    })
    const code = persistence.exchangeCodes.issue(USER_ID)

    // When
    const first = persistence.exchangeCodes.consume(code.value)
    const second = persistence.exchangeCodes.consume(code.value)

    // Then
    expect(first).toEqual({ kind: "accepted", userId: USER_ID })
    expect(second).toEqual({ kind: "rejected" })
    persistence.close()
  })

  it("rejects an expired OAuth exchange code without sleeping", async () => {
    // Given
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"))
    const persistence = openPersistence({
      path: await databasePath(),
      clock,
      random: new SequenceRandom(["exchange-expired"]),
    })
    const code = persistence.exchangeCodes.issue(USER_ID)
    clock.advance(60_001)

    // When
    const result = persistence.exchangeCodes.consume(code.value)

    // Then
    expect(result).toEqual({ kind: "rejected" })
    persistence.close()
  })

  it("authorizes, revokes, and expires opaque bearer sessions", async () => {
    // Given
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"))
    const persistence = openPersistence({
      path: await databasePath(),
      clock,
      random: new SequenceRandom(["active-session", "expiring-session"]),
    })
    const active = persistence.sessions.issue(USER_ID)
    const expiring = persistence.sessions.issue(USER_ID)

    // When
    const authorized = persistence.sessions.authorize(active.value)
    persistence.sessions.revoke(active.value)
    const revoked = persistence.sessions.authorize(active.value)
    clock.advance(8 * 60 * 60 * 1_000 + 1)
    const expired = persistence.sessions.authorize(expiring.value)

    // Then
    expect(authorized?.userId).toBe(USER_ID)
    expect(revoked).toBeNull()
    expect(expired).toBeNull()
    persistence.close()
  })

  it("stores only a SHA-256 session hash, never the raw bearer token", async () => {
    // Given
    const path = await databasePath()
    const rawToken = "raw-bearer-token-that-must-not-persist"
    const persistence = openPersistence({
      path,
      clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
      random: new SequenceRandom([rawToken]),
    })

    // When
    persistence.sessions.issue(USER_ID)
    persistence.close()
    const bytes = await readFile(path)
    const sqlite = new Database(path, { readonly: true })
    const row = z
      .object({ token_hash: z.string().regex(/^[a-f\d]{64}$/) })
      .parse(sqlite.prepare("SELECT token_hash FROM sessions").get())
    sqlite.close()

    // Then
    expect(bytes.includes(Buffer.from(rawToken))).toBe(false)
    expect(row.token_hash).not.toBe(rawToken)
  })

  it("deletes expired credentials with an explicit bounded cleanup", async () => {
    // Given
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"))
    const persistence = openPersistence({
      path: await databasePath(),
      clock,
      random: new SequenceRandom(["code-1", "code-2", "session-1"]),
    })
    persistence.exchangeCodes.issue(USER_ID)
    persistence.exchangeCodes.issue(USER_ID)
    persistence.sessions.issue(USER_ID)
    clock.advance(8 * 60 * 60 * 1_000 + 1)

    // When
    const first = persistence.cleanupExpired(2)
    const second = persistence.cleanupExpired(2)

    // Then
    expect(first.deleted).toBe(2)
    expect(second.deleted).toBe(1)
    persistence.close()
  })
})
