import { access, readFile, stat } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { MockTidalMusicSource } from "../../src/media/mock-tidal.js"
import { PrioritizedMusicSource } from "../../src/media/prioritized-source.js"
import type { MusicSource, PlayableMedia } from "../../src/media/types.js"

class RecordingSource implements MusicSource {
  readonly searches: string[] = []

  async search(query: string) {
    this.searches.push(query)
    return []
  }

  async resolve(): Promise<PlayableMedia> {
    throw new RangeError("No fallback track")
  }
}

describe("mock TIDAL provider", () => {
  it("prefers matching local lossless tracks and falls back when unavailable", async () => {
    // Given
    const fallback = new RecordingSource()
    const mock = new MockTidalMusicSource()
    const source = new PrioritizedMusicSource(mock, fallback, {
      preference: "mock_tidal_first",
      mockTidalConnected: true,
    })

    // When
    const local = await source.search("midnight circuit")
    const remote = await source.search("not in the classroom catalog")

    // Then
    expect(local.at(0)?.track).toMatchObject({ provider: "mock_tidal", title: "Midnight Circuit" })
    expect(fallback.searches).toEqual(["not in the classroom catalog"])
    expect(remote).toEqual([])
    await source.close()
  })

  it("generates a private seekable 48 kHz stereo WAV and removes it on close", async () => {
    // Given
    const source = new MockTidalMusicSource()
    const result = (await source.search("midnight circuit")).at(0)
    if (result === undefined) throw new RangeError("Expected mock catalog result")

    // When
    const media = await source.resolve(result.track)
    const header = await readFile(media.url)
    const mode = (await stat(media.url)).mode & 0o777

    // Then
    expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF")
    expect(header.readUInt16LE(22)).toBe(2)
    expect(header.readUInt32LE(24)).toBe(48_000)
    expect(media).toMatchObject({ container: "wav", codec: "pcm_s16le", seekable: true })
    expect(mode).toBe(0o600)
    await source.close()
    await expect(access(media.url)).rejects.toThrow()
  })

  it("uses YouTube only while the simulator is disconnected", async () => {
    // Given
    const fallback = new RecordingSource()
    const source = new PrioritizedMusicSource(new MockTidalMusicSource(), fallback, {
      preference: "mock_tidal_first",
      mockTidalConnected: false,
    })

    // When
    await source.search("midnight circuit")

    // Then
    expect(fallback.searches).toEqual(["midnight circuit"])
    await source.close()
  })
})
