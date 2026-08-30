import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, expect, it } from "vitest"
import { z } from "zod"

import { openDatabase } from "../../src/db/database.js"
import { openPersistence } from "../../src/db/index.js"
import { FixedClock, SequenceRandom } from "./fixtures.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

it("applies migrations idempotently when reopening a stale database", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "discord-music-migration-"))
  directories.push(directory)
  const path = join(directory, "server.sqlite")
  const stale = new Database(path)
  stale.exec(
    "CREATE TABLE unrelated_data (value TEXT NOT NULL); INSERT INTO unrelated_data VALUES ('kept')",
  )
  stale.close()
  const options = {
    path,
    clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
    random: new SequenceRandom(["unused"]),
  }

  // When
  openPersistence(options).close()
  openPersistence(options).close()
  const sqlite = new Database(path, { readonly: true })
  const migrationCount = z
    .object({ count: z.number().int() })
    .parse(sqlite.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).count
  const unrelated = z
    .object({ value: z.string() })
    .parse(sqlite.prepare("SELECT value FROM unrelated_data").get()).value
  sqlite.close()

  // Then
  expect(migrationCount).toBe(2)
  expect(unrelated).toBe("kept")
})

it("opens SQLite with WAL, foreign keys, and a bounded busy timeout", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "discord-music-pragmas-"))
  directories.push(directory)
  const path = join(directory, "server.sqlite")

  // When
  const sqlite = openDatabase(path)
  const journalMode = z.string().parse(sqlite.pragma("journal_mode", { simple: true }))
  const foreignKeys = z
    .number()
    .int()
    .parse(sqlite.pragma("foreign_keys", { simple: true }))
  const busyTimeout = z
    .number()
    .int()
    .parse(sqlite.pragma("busy_timeout", { simple: true }))
  sqlite.close()

  // Then
  expect(journalMode).toBe("wal")
  expect(foreignKeys).toBe(1)
  expect(busyTimeout).toBe(5_000)
})

it("creates a missing database parent with owner-only permissions", async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "discord-music-fresh-parent-"))
  directories.push(directory)
  const parent = join(directory, "fresh", "private")
  const path = join(parent, "server.sqlite")

  // When
  const sqlite = openDatabase(path)
  sqlite.close()

  // Then
  expect((await stat(parent)).mode & 0o777).toBe(0o700)
  expect((await stat(path)).isFile()).toBe(true)
})
