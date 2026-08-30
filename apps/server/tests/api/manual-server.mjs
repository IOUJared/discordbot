import { buildApp } from "../../dist/app.js"
import { OAuthStateStore } from "../../dist/auth/oauth-state.js"

const guildId = "guild"
const channelId = "voice"
const userId = "manual-user"
const listeners = new Set()
let connected = false
let volume = 100
let paused = false
let revoked = false
let exchangeAvailable = true
let sourcePreference = "youtube_only"
let mockTidalConnected = false
const queue = []

function publish() {
  for (const listener of listeners) listener()
}

const player = {
  snapshot: () => ({
    guildId,
    queue,
    currentItem: null,
    positionMs: 0,
    volume,
    isPaused: paused,
    loopMode: "off",
  }),
  voiceStatus: () => ({
    guildId,
    connected,
    channelId: connected ? channelId : null,
    muted: false,
    deafened: false,
  }),
  onStateChange: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  play: async () => queue[0],
  enqueue: async (track, requestedBy) => {
    const item = {
      id: `item-${queue.length + 1}`,
      track,
      requestedBy,
      addedAt: new Date().toISOString(),
    }
    queue.push(item)
    publish()
    return item
  },
  startIfIdle: async () => undefined,
  remove: (id) => {
    const index = queue.findIndex((item) => item.id === id)
    return queue.splice(index, 1)[0]
  },
  clear: () => {
    queue.splice(0)
    publish()
  },
  move: (id, index) => {
    const current = queue.findIndex((item) => item.id === id)
    const item = queue.splice(current, 1)[0]
    if (item !== undefined) queue.splice(index, 0, item)
    publish()
  },
  playNext: () => publish(),
  playSelected: async () => publish(),
  pause: () => {
    paused = true
    publish()
    return true
  },
  resume: () => {
    paused = false
    publish()
    return true
  },
  skip: async () => publish(),
  next: async () => publish(),
  stop: () => {
    queue.splice(0)
    publish()
  },
  restart: async () => publish(),
  seek: async () => publish(),
  setVolume: (nextVolume) => {
    volume = nextVolume
    publish()
  },
  setLoop: () => publish(),
  shuffle: () => publish(),
  join: async () => {
    connected = true
    publish()
  },
  leave: async () => {
    connected = false
    publish()
  },
  providerSettings: () => ({ preference: sourcePreference, mockTidalConnected }),
  setSourcePreference: (preference) => {
    sourcePreference = preference
    publish()
  },
  connectMockTidal: () => {
    sourcePreference = "mock_tidal_first"
    mockTidalConnected = true
    publish()
  },
  disconnectMockTidal: () => {
    sourcePreference = "youtube_only"
    mockTidalConnected = false
    publish()
  },
}

const app = await buildApp({
  config: {
    discordToken: "fixture",
    discordClientId: "fixture",
    discordClientSecret: "fixture",
    guildId,
    discordOwnerId: userId,
    authorizedUserIds: new Set([userId]),
    frontendUrl: "http://127.0.0.1:4173",
    frontendOrigin: "http://127.0.0.1:4173",
    publicUrl: "http://127.0.0.1:0",
    databasePath: ":memory:",
    host: "127.0.0.1",
    port: 0,
    voiceIdleTimeoutMs: 300_000,
    logLevel: "silent",
    discordApiUrl: "http://127.0.0.1:1",
  },
  oauth: {
    exchange: async () => ({ id: userId, username: "fixture" }),
    isGuildMember: async () => true,
  },
  oauthStates: new OAuthStateStore(Date.now, () => "fixture-random"),
  exchangeCodes: {
    issue: () => ({ value: "manual-code", expiresAt: new Date(Date.now() + 60_000) }),
    consume: (code) => {
      if (code !== "manual-code" || !exchangeAvailable) return { kind: "rejected" }
      exchangeAvailable = false
      return { kind: "accepted", userId }
    },
  },
  sessions: {
    issue: () => ({ value: "manual-session", expiresAt: new Date(Date.now() + 28_800_000) }),
    authorize: (token) =>
      token === "manual-session" && !revoked
        ? { userId, expiresAt: new Date(Date.now() + 28_800_000) }
        : null,
    revoke: () => {
      revoked = true
    },
  },
  player,
  search: {
    search: async () => [
      {
        track: {
          id: "search-track",
          provider: "youtube",
          title: "Search Result",
          artist: "Artist",
          url: "https://www.youtube.com/watch?v=manualfixture",
          durationMs: 60_000,
        },
        score: 1,
      },
    ],
  },
  guildId,
  history: { list: () => [] },
  voiceChannels: async () => [{ id: channelId, name: "General" }],
  dependencies: { ffmpeg: true, ytDlp: true },
  discordReady: () => true,
  startedAtMs: Date.now(),
})

const address = await app.listen({ host: "127.0.0.1", port: 0 })
process.stdout.write(`${address}\n`)
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app.close()
  })
