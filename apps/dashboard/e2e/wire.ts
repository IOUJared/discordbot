import type { Page } from "@playwright/test"

export const track = (id: string, title: string, artist: string) => ({
  id,
  provider: "youtube",
  title,
  artist,
  url: `https://example.com/${id}`,
  durationMs: 240_000,
  artworkUrl: "http://127.0.0.1:4174/artwork-mountain.png",
})

export const item = (id: string, title: string, artist: string) => ({
  id,
  track: track(`track-${id}`, title, artist),
  requestedBy: "listener-1",
  addedAt: "2026-08-29T12:00:00.000Z",
})

export const room = {
  version: 7,
  player: {
    guildId: "guild-1",
    queue: [
      item(
        "queue-1",
        "Still Water Across a Very Long Listening Session Name That Must Never Force Overflow",
        "North Window",
      ),
      item("queue-2", "Signal Fires", "Low Meridian"),
      item("queue-3", "After Midnight", "Quiet Atlas"),
      item("queue-4", "Fading Satellites", "Harbor Glass"),
      item("queue-5", "Open Water", "Night Orchard"),
      item("queue-6", "Slow Horizon", "Paper Atlas"),
    ],
    currentItem: item("current", "Mountain Echoes", "Harbor Lights"),
    bitrateKbps: 252,
    seekable: true,
    positionMs: 84_000,
    volume: 72,
    isPaused: false,
    loopMode: "off",
  },
  voice: {
    guildId: "guild-1",
    connected: true,
    channelId: "voice-1",
    muted: false,
    deafened: false,
  },
}

export const emptyRoom = {
  ...room,
  version: 8,
  player: { ...room.player, currentItem: null, seekable: false, queue: [], positionMs: 0 },
  voice: { ...room.voice, connected: false, channelId: null },
}

export type WireOptions = {
  readonly state?: typeof room | typeof emptyRoom
  readonly history?: readonly ReturnType<typeof historyItem>[]
  readonly searchError?: boolean
  readonly failureGate?: Promise<void>
  readonly voiceChannelsGate?: Promise<void>
  readonly failure?: {
    readonly version: 1
    readonly type: "playback.failed"
    readonly payload: {
      readonly guildId: string
      readonly queueItemId: string
      readonly trackId: string
      readonly provider: "youtube"
      readonly title: string
      readonly artist: string
      readonly message: "Playback failed; skipped to the next track."
    }
  }
}

function historyItem() {
  return {
    id: "history-1",
    queueItem: item("old", "Distant Shore", "Paper Satellites"),
    playedAt: "2026-08-29T11:00:00.000Z",
    endedAt: "2026-08-29T11:04:00.000Z",
    endReason: "finished",
  }
}

export async function mockWire(page: Page, options: WireOptions = {}): Promise<void> {
  const state = options.state ?? room
  const history = options.history ?? [historyItem()]
  let failureDelivered = false
  await page.routeWebSocket("**/ws", (socket) => {
    socket.onMessage(async (message) => {
      const parsed: unknown = JSON.parse(String(message))
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "type" in parsed &&
        parsed.type === "auth"
      ) {
        socket.send(JSON.stringify({ version: 1, type: "state.snapshot", payload: state }))
        if (options.voiceChannelsGate !== undefined) {
          await options.voiceChannelsGate
          socket.send(
            JSON.stringify({
              version: 1,
              type: "voice.channels",
              payload: {
                channels: [
                  { id: "voice-1", name: "Main Room", memberCount: 3 },
                  { id: "voice-2", name: "Lounge", memberCount: 2 },
                ],
              },
            }),
          )
        }
        if (options.failure !== undefined && !failureDelivered) {
          failureDelivered = true
          await options.failureGate
          socket.send(JSON.stringify(options.failure))
        }
      }
    })
  })
  await page.route("**/api/**", async (route) => route.fulfill({ json: state }))
  await page.route("**/auth/exchange", async (route) =>
    route.fulfill({ json: { token: "browser-token", expiresAt: "2099-01-01T00:00:00.000Z" } }),
  )
  await page.route("**/auth/logout", async (route) => route.fulfill({ status: 204 }))
  await page.route("**/api/state", async (route) => route.fulfill({ json: state }))
  await page.route("**/api/voice-channels", async (route) =>
    route.fulfill({
      json: {
        channels: [
          { id: "voice-1", name: "Main Room", memberCount: 2 },
          { id: "voice-2", name: "Lounge", memberCount: 3 },
        ],
      },
    }),
  )
  await page.route("**/api/history", async (route) => route.fulfill({ json: { items: history } }))
  await page.route("**/api/search", async (route) => {
    if (options.searchError) {
      await route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "Search is temporarily unavailable" } },
      })
      return
    }
    await route.fulfill({
      json: {
        results: [
          {
            track: track("search-1", "Northern Lines", "Small Hours"),
            score: 0.94,
            bitrateKbps: 252,
          },
        ],
      },
    })
  })
  await page.route("**/api/queue/order", async (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: "stale_version", message: "Player state changed" } },
    }),
  )
}
