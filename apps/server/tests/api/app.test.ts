import {
  ChannelIdSchema,
  GuildIdSchema,
  type MediaProviderSettings,
  PositionMsSchema,
  QueueItemSchema,
  TrackSchema,
  UserIdSchema,
  VolumeSchema,
} from "@discord-music/contracts"
import type { FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { z } from "zod"
import type { PlayerApi } from "../../src/api/types.js"
import { type AppDeps, buildApp } from "../../src/app.js"
import { OAuthStateStore } from "../../src/auth/oauth-state.js"

const userId = UserIdSchema.parse("user-a")
const guildId = GuildIdSchema.parse("guild")
const channelId = ChannelIdSchema.parse("voice")
const track = TrackSchema.parse({
  id: "track",
  provider: "youtube",
  title: "Example",
  artist: "Artist",
  url: "https://www.youtube.com/watch?v=track",
  durationMs: 120_000,
})
const item = QueueItemSchema.parse({
  id: "item",
  track,
  requestedBy: userId,
  addedAt: "2026-01-01T00:00:00.000Z",
})

class FakePlayer implements PlayerApi {
  readonly calls: string[] = []
  private readonly listeners = new Set<() => void>()
  connected = false
  providers: MediaProviderSettings = { preference: "youtube_only", mockTidalConnected: false }
  snapshot() {
    return {
      guildId,
      queue: [],
      currentItem: null,
      positionMs: PositionMsSchema.parse(0),
      volume: VolumeSchema.parse(100),
      isPaused: false,
      loopMode: "off" as const,
    }
  }
  voiceStatus() {
    return {
      guildId,
      connected: this.connected,
      channelId: this.connected ? channelId : null,
      muted: false,
      deafened: false,
    }
  }
  onStateChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async play() {
    return item
  }
  async enqueue() {
    this.calls.push("enqueue")
    return item
  }
  async startIfIdle() {
    this.calls.push("start")
  }
  remove() {
    return item
  }
  clear() {
    this.calls.push("clear")
  }
  move() {
    this.calls.push("move")
  }
  playNext() {
    this.calls.push("next")
  }
  async playSelected() {
    this.calls.push("play")
  }
  pause() {
    this.calls.push("pause")
    return true
  }
  resume() {
    this.calls.push("resume")
    return true
  }
  async skip() {
    this.calls.push("skip")
  }
  async next() {
    this.calls.push("next")
  }
  stop() {
    this.calls.push("stop")
  }
  async restart() {
    this.calls.push("restart")
  }
  async seek() {
    this.calls.push("seek")
  }
  setVolume() {
    this.calls.push("volume")
  }
  setLoop() {
    this.calls.push("loop")
  }
  shuffle() {
    this.calls.push("shuffle")
  }
  async join() {
    this.calls.push("join")
    this.connected = true
  }
  async leave() {
    this.calls.push("leave")
    this.connected = false
  }
  providerSettings() {
    return this.providers
  }
  setSourcePreference(preference: "mock_tidal_first" | "youtube_only") {
    this.calls.push("provider-preference")
    this.providers = { ...this.providers, preference }
  }
  connectMockTidal() {
    this.calls.push("mock-tidal-connect")
    this.providers = { preference: "mock_tidal_first", mockTidalConnected: true }
  }
  disconnectMockTidal() {
    this.calls.push("mock-tidal-disconnect")
    this.providers = { preference: "youtube_only", mockTidalConnected: false }
  }
}

const apps: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function fixture(): Promise<{ readonly app: FastifyInstance; readonly player: FakePlayer }> {
  const player = new FakePlayer()
  const deps: AppDeps = {
    config: {
      discordToken: "secret",
      discordClientId: "client",
      discordClientSecret: "secret",
      guildId: "guild",
      discordOwnerId: "user-a",
      authorizedUserIds: new Set(["user-a"]),
      frontendUrl: "https://music.example.com",
      frontendOrigin: "https://music.example.com",
      publicUrl: "https://api.example.com",
      databasePath: ":memory:",
      host: "127.0.0.1",
      port: 0,
      voiceIdleTimeoutMs: 300_000,
      logLevel: "silent",
      discordApiUrl: "https://discord.com/api/v10",
    },
    oauth: {
      exchange: async () => ({ id: "user-a", username: "user" }),
      isGuildMember: async () => true,
    },
    oauthStates: new OAuthStateStore(
      () => 1_000,
      () => "random",
    ),
    exchangeCodes: {
      issue: () => ({ value: "code", expiresAt: new Date(2_000) }),
      consume: (value) => (value === "code" ? { kind: "accepted", userId } : { kind: "rejected" }),
    },
    sessions: {
      issue: () => ({ value: "valid", expiresAt: new Date(28_801_000) }),
      authorize: (value) =>
        value === "valid" ? { userId, expiresAt: new Date(28_801_000) } : null,
      revoke: () => undefined,
    },
    player,
    search: { search: async () => [] },
    guildId,
    history: { list: () => [] },
    voiceChannels: async () => [{ id: channelId, name: "General" }],
    dependencies: { ffmpeg: true, ytDlp: true },
    discordReady: () => true,
    startedAtMs: Date.now(),
  }
  const app = await buildApp(deps)
  apps.push(app)
  return { app, player }
}

describe("Fastify API", () => {
  it("Given a health request When unauthenticated Then only public readiness fields are returned", async () => {
    const { app } = await fixture()
    const response = await app.inject({ method: "GET", url: "/health" })
    expect(response.statusCode).toBe(200)
    expect(Object.keys(response.json()).sort()).toEqual(["discord", "status", "uptime", "voice"])
  })

  it("Given protected routes When no bearer is provided Then each returns 401", async () => {
    const { app } = await fixture()
    const requests = [
      ["GET", "/api/state"],
      ["POST", "/api/search"],
      ["GET", "/api/history"],
      ["GET", "/api/voice-channels"],
      ["POST", "/api/queue"],
      ["DELETE", "/api/queue/item"],
      ["PATCH", "/api/queue/order"],
      ["POST", "/api/queue/item/next"],
      ["POST", "/api/queue/item/play"],
      ["POST", "/api/player/pause"],
      ["POST", "/api/player/resume"],
      ["POST", "/api/player/skip"],
      ["POST", "/api/player/stop"],
      ["POST", "/api/player/restart"],
      ["POST", "/api/player/seek"],
      ["POST", "/api/player/volume"],
      ["POST", "/api/player/loop"],
      ["POST", "/api/player/shuffle"],
      ["POST", "/api/voice/join"],
      ["POST", "/api/voice/leave"],
      ["PATCH", "/api/providers/preference"],
      ["POST", "/api/providers/mock-tidal/connect"],
      ["POST", "/api/providers/mock-tidal/disconnect"],
      ["DELETE", "/api/queue"],
      ["GET", "/auth/me"],
      ["POST", "/auth/logout"],
    ] as const
    const responses = await Promise.all(
      requests.map(([method, url]) => app.inject({ method, url })),
    )
    expect(responses.every((response) => response.statusCode === 401)).toBe(true)
  })

  it("Given an authenticated invalid volume When posted Then validation returns stable 400", async () => {
    const { app } = await fixture()
    const response = await app.inject({
      method: "POST",
      url: "/api/player/volume",
      headers: { authorization: "Bearer valid" },
      payload: { volume: 201 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: { code: "validation_error", message: "Invalid request" },
    })
  })

  it.each([" application/json", "\tapplication/json"])(
    "Given an authenticated queue mutation with Content-Type whitespace and an invalid body When posted Then validation rejects it before player effects",
    async (contentType) => {
      const { app, player } = await fixture()
      const response = await app.inject({
        method: "POST",
        url: "/api/queue",
        headers: {
          authorization: "Bearer valid",
          "content-type": contentType,
        },
        payload: { expectedVersion: -1 },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({
        error: { code: "validation_error", message: "Invalid request" },
      })
      expect(player.calls).toEqual([])
    },
  )

  it("Given a disconnected player When adding with a channel Then it joins and queues as session user", async () => {
    const { app, player } = await fixture()
    const response = await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: "Bearer valid" },
      payload: { track, channelId, expectedVersion: 0 },
    })
    expect(response.statusCode).toBe(200)
    expect(player.calls).toEqual(["join", "enqueue", "start"])
  })

  it("Given a stale queue version When ordering Then it returns typed 409 with a fresh snapshot", async () => {
    const { app } = await fixture()
    const response = await app.inject({
      method: "PATCH",
      url: "/api/queue/order",
      headers: { authorization: "Bearer valid" },
      payload: { id: "item", index: 0, expectedVersion: 9 },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: { code: "stale_version", message: "Player state changed" },
      snapshot: { version: 0 },
    })
  })

  it("Given each queue mutation has a stale version When requested Then it returns the current snapshot without changing the player", async () => {
    const { app, player } = await fixture()
    const headers = { authorization: "Bearer valid" }
    const requests = [
      app.inject({
        method: "POST",
        url: "/api/queue",
        headers,
        payload: { track, channelId, expectedVersion: 9 },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/queue/item",
        headers,
        payload: { expectedVersion: 9 },
      }),
      app.inject({
        method: "DELETE",
        url: "/api/queue",
        headers,
        payload: { expectedVersion: 9 },
      }),
      app.inject({
        method: "PATCH",
        url: "/api/queue/order",
        headers,
        payload: { id: "item", index: 0, expectedVersion: 9 },
      }),
      app.inject({
        method: "POST",
        url: "/api/queue/item/next",
        headers,
        payload: { expectedVersion: 9 },
      }),
      app.inject({
        method: "POST",
        url: "/api/queue/item/play",
        headers,
        payload: { expectedVersion: 9 },
      }),
    ]
    const responses = await Promise.all(requests)
    expect(responses.every((response) => response.statusCode === 409)).toBe(true)
    expect(responses.every((response) => response.json().snapshot.version === 0)).toBe(true)
    expect(player.calls).toEqual([])
  })

  it("Given a queue mutation lacks expectedVersion When authenticated Then boundary validation rejects it", async () => {
    const { app } = await fixture()
    const headers = { authorization: "Bearer valid" }
    const requests = [
      app.inject({ method: "POST", url: "/api/queue", headers, payload: { track, channelId } }),
      app.inject({ method: "DELETE", url: "/api/queue/item", headers, payload: {} }),
      app.inject({ method: "DELETE", url: "/api/queue", headers, payload: {} }),
      app.inject({
        method: "PATCH",
        url: "/api/queue/order",
        headers,
        payload: { id: "item", index: 0 },
      }),
      app.inject({ method: "POST", url: "/api/queue/item/next", headers, payload: {} }),
      app.inject({ method: "POST", url: "/api/queue/item/play", headers, payload: {} }),
    ]
    const responses = await Promise.all(requests)
    expect(responses.every((response) => response.statusCode === 400)).toBe(true)
  })

  it("Given a valid authenticated search request When posted Then it is dispatched", async () => {
    const { app } = await fixture()
    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { authorization: "Bearer valid" },
      payload: { q: "lofi" },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ results: [] })
  })

  it("Given an authorized owner When connecting the simulator Then mock TIDAL becomes first priority", async () => {
    const { app, player } = await fixture()
    const response = await app.inject({
      method: "POST",
      url: "/api/providers/mock-tidal/connect",
      headers: { authorization: "Bearer valid" },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().providers).toEqual({
      preference: "mock_tidal_first",
      mockTidalConnected: true,
    })
    expect(player.calls).toEqual(["mock-tidal-connect"])
  })

  it("Given an invalid source preference When posted Then validation rejects it", async () => {
    const { app, player } = await fixture()
    const response = await app.inject({
      method: "PATCH",
      url: "/api/providers/preference",
      headers: { authorization: "Bearer valid" },
      payload: { preference: "real_tidal" },
    })
    expect(response.statusCode).toBe(400)
    expect(player.calls).toEqual([])
  })

  it("Given Discord OAuth starts When it creates a redirect Then it uses the documented callback path", async () => {
    const { app } = await fixture()
    const response = await app.inject({ method: "GET", url: "/auth/discord" })
    expect(response.statusCode).toBe(302)
    expect(new URL(response.headers.location ?? "").searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/discord/callback",
    )
  })

  it("Given a valid OAuth callback When received at the documented path Then it exchanges and redirects", async () => {
    const { app } = await fixture()
    await app.inject({ method: "GET", url: "/auth/discord" })
    const response = await app.inject({
      method: "GET",
      url: "/auth/discord/callback?code=code&state=random",
    })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe("https://music.example.com/#code=code")
  })

  it("Given allowed and foreign origins When requesting Then CORS echoes only the configured origin", async () => {
    const { app } = await fixture()
    const allowed = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://music.example.com" },
    })
    const denied = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    })
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://music.example.com")
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("Given a valid bearer over WebSocket When connected and mutated Then snapshots arrive", async () => {
    const { app } = await fixture()
    const address = await app.listen({ host: "127.0.0.1", port: 0 })
    const socket = new WebSocket(`${address.replace("http", "ws")}/ws`, {
      origin: "https://music.example.com",
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "auth", token: "valid" }))
        resolve()
      })
      socket.once("error", reject)
    })
    const first = await nextMessage(socket)
    const mutation = app.inject({
      method: "POST",
      url: "/api/player/pause",
      headers: { authorization: "Bearer valid" },
    })
    const second = await nextMessage(socket)
    await mutation
    socket.close()
    expect(first.type).toBe("state.snapshot")
    expect(second.payload.version).toBeGreaterThan(first.payload.version)
  })

  it("Given a foreign WebSocket Origin When connected Then policy rejection closes it", async () => {
    const { app } = await fixture()
    const address = await app.listen({ host: "127.0.0.1", port: 0 })
    const socket = new WebSocket(`${address.replace("http", "ws")}/ws`, {
      origin: "https://evil.example",
    })
    const code = await new Promise<number>((resolve, reject) => {
      socket.once("close", resolve)
      socket.once("error", reject)
    })
    expect(code).toBe(1008)
  })

  it("Given malformed WebSocket authentication When sent Then policy rejection closes it", async () => {
    const { app } = await fixture()
    const address = await app.listen({ host: "127.0.0.1", port: 0 })
    const socket = new WebSocket(`${address.replace("http", "ws")}/ws`, {
      origin: "https://music.example.com",
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        socket.send("not-json")
        resolve()
      })
      socket.once("error", reject)
    })
    const code = await new Promise<number>((resolve) => socket.once("close", resolve))
    expect(code).toBe(1008)
  })

  it("Given requests above the configured window When sent Then rate limiting returns 429", async () => {
    const { app } = await fixture()
    const responses = await Promise.all(
      Array.from({ length: 121 }, () => app.inject({ method: "GET", url: "/health" })),
    )
    expect(responses.at(-1)?.statusCode).toBe(429)
  })
})

const socketMessageSchema = z.object({
  type: z.string(),
  payload: z.object({ version: z.number() }).passthrough(),
})

async function nextMessage(socket: WebSocket): Promise<z.infer<typeof socketMessageSchema>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) =>
      resolve(socketMessageSchema.parse(JSON.parse(data.toString()))),
    )
    socket.once("error", reject)
  })
}
