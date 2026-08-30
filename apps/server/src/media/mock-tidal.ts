import type { SearchResult, Track } from "@discord-music/contracts"

import { GeneratedWavStore } from "./generated-wav-store.js"
import { mockTidalCatalogEntry, searchMockTidalCatalog } from "./mock-tidal-catalog.js"
import type { MusicSource, PlayableMedia } from "./types.js"

export class MockTidalMusicSource implements MusicSource {
  constructor(private readonly wavStore = new GeneratedWavStore()) {}

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    signal?.throwIfAborted()
    return searchMockTidalCatalog(query)
  }

  async resolve(track: Track, signal?: AbortSignal): Promise<PlayableMedia> {
    signal?.throwIfAborted()
    const entry = mockTidalCatalogEntry(track.id)
    if (track.provider !== "mock_tidal" || entry === undefined) {
      throw new RangeError("Track is not available in the mock TIDAL catalog")
    }
    const path = await this.wavStore.get(entry.slug, entry.durationSeconds, entry.frequencyHz)
    signal?.throwIfAborted()
    return { url: path, headers: {}, container: "wav", codec: "pcm_s16le", seekable: true }
  }

  close(): Promise<void> {
    return this.wavStore.close()
  }
}
