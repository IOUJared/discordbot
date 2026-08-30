import { base } from "$app/paths"
import {
  PlayerSnapshotSchema,
  QueueItemSchema,
  type MediaProviderSettings,
} from "@discord-music/contracts"

const artworkUrl = new URL(`${base}/artwork-mountain.png`, location.origin).href

export const showcaseItem = QueueItemSchema.parse({
  id: "showcase-queue",
  track: {
    id: "showcase-track",
    provider: "youtube",
    title: "A very long track title that tests wrapping without breaking the control room",
    artist: "Midnight Relay",
    url: "https://example.com/showcase",
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
  positionMs: 74_000,
  volume: 72,
  isPaused: false,
  loopMode: "queue",
})

export const emptyPlayer = PlayerSnapshotSchema.parse({
  guildId: "showcase-guild",
  queue: [],
  currentItem: null,
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
