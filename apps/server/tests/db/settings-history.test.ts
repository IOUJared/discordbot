import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VolumeSchema } from "@discord-music/contracts"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import { openPersistence } from "../../src/db/index.js"
import { FixedClock, GUILD_ID, historyItem, SequenceRandom } from "./fixtures.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "discord-music-db-"))
  directories.push(directory)
  return join(directory, "server.sqlite")
}

describe("guild settings and history persistence", () => {
  it("returns defaults when a guild has no saved settings", async () => {
    // Given
    const persistence = openPersistence({
      path: await databasePath(),
      clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
      random: new SequenceRandom(["unused"]),
    })

    // When
    const settings = persistence.settings.get(GUILD_ID)

    // Then
    expect(settings).toEqual({
      volume: 100,
      loopMode: "off",
    })
    persistence.close()
  })

  it("restores updated settings after reopening the database", async () => {
    // Given
    const path = await databasePath()
    const options = {
      path,
      clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
      random: new SequenceRandom(["unused"]),
    }
    const first = openPersistence(options)
    first.settings.set(GUILD_ID, {
      volume: VolumeSchema.parse(175),
      loopMode: "queue",
    })
    first.close()

    // When
    const reopened = openPersistence(options)

    // Then
    expect(reopened.settings.get(GUILD_ID)).toEqual({
      volume: 175,
      loopMode: "queue",
    })
    reopened.close()
  })

  it("keeps exactly the latest 200 history items", async () => {
    // Given
    const persistence = openPersistence({
      path: await databasePath(),
      clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
      random: new SequenceRandom(["unused"]),
    })

    // When
    for (let index = 0; index < 205; index += 1) {
      persistence.history.append(GUILD_ID, historyItem(index))
    }

    // Then
    const history = persistence.history.list(GUILD_ID)
    expect(history).toHaveLength(200)
    expect(history.at(0)?.id).toBe("history-204")
    expect(history.at(-1)?.id).toBe("history-5")
    persistence.close()
  })

  it("rolls back all writes when a transaction is interrupted", async () => {
    // Given
    const persistence = openPersistence({
      path: await databasePath(),
      clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
      random: new SequenceRandom(["unused"]),
    })

    // When
    expect(() =>
      persistence.transaction(() => {
        persistence.history.append(GUILD_ID, historyItem(1))
        throw new RangeError("simulated interrupt")
      }),
    ).toThrow(RangeError)

    // Then
    expect(persistence.history.list(GUILD_ID)).toEqual([])
    persistence.close()
  })

  it("rejects a malformed row at the repository boundary", async () => {
    // Given
    const path = await databasePath()
    const options = {
      path,
      clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
      random: new SequenceRandom(["unused"]),
    }
    openPersistence(options).close()
    const sqlite = new Database(path)
    sqlite.pragma("ignore_check_constraints = ON")
    sqlite
      .prepare(
        "INSERT INTO guild_settings (guild_id, volume, loop_mode, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(GUILD_ID, 999, "off", 0)
    sqlite.close()
    const persistence = openPersistence(options)

    // When
    const readMalformedRow = () => persistence.settings.get(GUILD_ID)

    // Then
    expect(readMalformedRow).toThrow()
    persistence.close()
  })
})
