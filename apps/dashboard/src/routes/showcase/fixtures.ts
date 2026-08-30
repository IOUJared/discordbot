import type {
  MediaProviderSettings,
  LoopMode,
  PlayerSnapshot,
  QueueItem,
} from "@discord-music/contracts"

const artworkUrl = "/artwork-mountain.png"

export const showcaseItem: QueueItem = {
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
}

const loopQueue: LoopMode = "queue"

const basePlayerDefaults = {
  guildId: "showcase-guild",
  seekable: true,
  positionMs: 0,
  volume: 72,
  isPaused: true,
  loopMode: "off" as LoopMode,
}

export const showcasePlayer: PlayerSnapshot = {
  ...basePlayerDefaults,
  guildId: "showcase-guild",
  queue: [showcaseItem],
  currentItem: showcaseItem,
  seekable: true,
  positionMs: 74_000,
  volume: 72,
  isPaused: false,
  loopMode: loopQueue,
}

export const emptyPlayer: PlayerSnapshot = {
  ...basePlayerDefaults,
  guildId: "showcase-guild",
  queue: [],
  currentItem: null,
  seekable: false,
}

export const connectedSettings: MediaProviderSettings = {
  preference: "mock_tidal_first",
  mockTidalConnected: true,
}

export const disconnectedSettings: MediaProviderSettings = {
  preference: "youtube_only",
  mockTidalConnected: false,
}
