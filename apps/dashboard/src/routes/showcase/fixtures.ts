import type { MediaProviderSettings } from "@discord-music/contracts"
import { PlayerSnapshotSchema, QueueItemSchema } from "@discord-music/contracts"

const artworkUrl = "https://showcase.invalid/artwork-mountain.png"

export const showcaseItem = QueueItemSchema.parse({
  id: "showcase-queue",
  track: {
    id: "showcase-track",
    provider: "youtube",
    title: "A very long track title that tests wrapping without breaking the control room",
    artist: "Midnight Relay",
    url: "https://www.youtube.com/watch?v=showcase",
    durationMs: 220_000,
    artworkUrl,
  },
  requestedBy: "showcase-user",
  addedAt: "2026-08-29T12:00:00.000Z",
})

export const showcasePlayer = PlayerSnapshotSchema.parse({
  guildId: "showcase-guild",
  queue: [showcaseItem],
  currentItem: showcaseItem,
  bitrateKbps: 252,
  seekable: true,
  positionMs: 74_000,
  volume: 72,
  isPaused: false,
  loopMode: "queue",
})

export const emptyPlayer = PlayerSnapshotSchema.parse({
  guildId: "showcase-guild",
  queue: [],
  currentItem: null,
  seekable: false,
  positionMs: 0,
  volume: 72,
  isPaused: true,
  loopMode: "off",
})

export const connectedSettings: MediaProviderSettings = {
  preference: "mock_tidal_first",
  mockTidalConnected: true,
}

export const disconnectedSettings: MediaProviderSettings = {
  preference: "youtube_only",
  mockTidalConnected: false,
}
