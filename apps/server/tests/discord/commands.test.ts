import {
  ChannelIdSchema,
  DurationMsSchema,
  GuildIdSchema,
  PositionMsSchema,
  type QueueItem,
  QueueItemIdSchema,
  TimestampSchema,
  type Track,
  TrackIdSchema,
  UserIdSchema,
  VolumeSchema,
  type YouTubePlaylist,
} from "@discord-music/contracts"
import { ApplicationCommandOptionType } from "discord.js"
import { describe, expect, it } from "vitest"
import { PlayerCommandService, type PlayerControls } from "../../src/discord/command-service.js"
import {
  COMMAND_DEFINITIONS,
  COMMAND_NAMES,
  type CommandContext,
  type CommandRouter,
  createCommandRouter,
} from "../../src/discord/commands.js"
import {
  handleIncomingInteraction,
  handleInteraction,
  handleInteractionBoundary,
  type InteractionCommandPort,
  type InteractionFailure,
} from "../../src/discord/interaction.js"
import type { RadioSource } from "../../src/media/types.js"

const guildId = GuildIdSchema.parse("guild-1")
const ownerId = UserIdSchema.parse("owner")
const voiceChannelId = ChannelIdSchema.parse("voice-1")
const queueItem: QueueItem = {
  id: QueueItemIdSchema.parse("queue-1"),
  track: {
    id: TrackIdSchema.parse("track-1"),
    provider: "youtube",
    title: "Song",
    artist: "Artist",
    url: "https://youtube.example/watch?v=1",
    durationMs: DurationMsSchema.parse(180_000),
  },
  requestedBy: ownerId,
  addedAt: TimestampSchema.parse("2026-01-01T00:00:00.000Z"),
}

class FakeControls implements PlayerControls {
  readonly calls: string[] = []
  async play() {
    this.calls.push("play")
    return queueItem
  }
  async enqueue(_track: Track) {
    this.calls.push("enqueue")
    return queueItem
  }
  async enqueueMany(tracks: readonly Track[]) {
    this.calls.push(`enqueueMany:${tracks.length}`)
    return tracks.map(() => queueItem)
  }
  async startIfIdle() {
    this.calls.push("startIfIdle")
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
  stop() {
    this.calls.push("stop")
  }
  snapshot() {
    this.calls.push("snapshot")
    return {
      guildId,
      queue: [queueItem],
      currentItem: queueItem,
      seekable: true,
      positionMs: PositionMsSchema.parse(0),
      volume: VolumeSchema.parse(100),
      isPaused: false,
      loopMode: "off" as const,
    }
  }
  remove() {
    this.calls.push("remove")
    return queueItem
  }
  clear() {
    this.calls.push("clear")
  }
  shuffle() {
    this.calls.push("shuffle")
  }
  setLoop() {
    this.calls.push("loop")
  }
  setVolume() {
    this.calls.push("volume")
  }
  async seek() {
    this.calls.push("seek")
  }
  async join() {
    this.calls.push("join")
  }
  async leave() {
    this.calls.push("leave")
  }
}

const radioPlaylist: YouTubePlaylist = {
  id: "radio-playlist",
  title: "Indie Rock Essentials",
  author: "YouTube curator",
  tracks: Array.from({ length: 75 }, (_, index) => ({
    ...queueItem.track,
    id: TrackIdSchema.parse(`radio-track-${index}`),
    title: `Radio song ${index + 1}`,
    url: `https://www.youtube.com/watch?v=radio-track-${index}`,
  })),
}

const radioSource: RadioSource = {
  radio: async () => radioPlaylist,
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    guildId,
    userId: ownerId,
    voiceChannelId,
    name: "pause",
    options: {},
    ...overrides,
  }
}

describe("Discord command router", () => {
  it("registers every required guild command", () => {
    // Given
    const required = [
      "play",
      "radio",
      "pause",
      "resume",
      "skip",
      "stop",
      "queue",
      "nowplaying",
      "remove",
      "clear",
      "shuffle",
      "loop",
      "volume",
      "seek",
      "join",
      "leave",
    ]

    // When
    const registered = [...COMMAND_NAMES]

    // Then
    expect(registered).toEqual(required)
  })

  it("exports registration-ready typed options for value-bearing commands", () => {
    // Given
    const definitions = new Map(
      COMMAND_DEFINITIONS.map((definition) => [definition.name, definition]),
    )

    // When
    const option = (name: string) => {
      const value = definitions.get(name)?.options?.at(0)
      if (value === undefined) throw new RangeError(`Missing test option: ${name}`)
      return value
    }

    // When
    const play = option("play")
    const radio = option("radio")
    const remove = option("remove")
    const loop = option("loop")
    const volume = option("volume")
    const seek = option("seek")

    // Then
    expect(play).toMatchObject({
      name: "query",
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    expect(radio).toMatchObject({
      name: "genre",
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    expect(remove).toMatchObject({
      name: "id",
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    expect(loop).toMatchObject({
      name: "mode",
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    expect(loop).toHaveProperty("choices", [
      { name: "off", value: "off" },
      { name: "track", value: "track" },
      { name: "queue", value: "queue" },
    ])
    expect(volume).toMatchObject({
      type: ApplicationCommandOptionType.Integer,
      min_value: 0,
      max_value: 200,
    })
    expect(seek).toMatchObject({ type: ApplicationCommandOptionType.Integer, min_value: 0 })
  })

  it("rejects users outside the authorized set", async () => {
    // Given
    const router = createCommandRouter({
      guildId,
      authorizedUserIds: new Set([ownerId]),
      service: { execute: async () => ({ kind: "ok", message: "done" }) },
    })

    // When
    const result = await router.handle(context({ userId: UserIdSchema.parse("intruder") }))

    // Then
    expect(result.kind).toBe("rejected")
  })

  it("rejects commands from another guild", async () => {
    // Given
    const router = createCommandRouter({
      guildId,
      authorizedUserIds: new Set([ownerId]),
      service: { execute: async () => ({ kind: "ok", message: "done" }) },
    })

    // When
    const result = await router.handle(context({ guildId: GuildIdSchema.parse("guild-2") }))

    // Then
    expect(result.kind).toBe("rejected")
  })

  it("maps an authorized command to the command service", async () => {
    // Given
    const calls: CommandContext[] = []
    const command = context({ name: "skip" })
    const router = createCommandRouter({
      guildId,
      authorizedUserIds: new Set([ownerId]),
      service: {
        execute: async (received) => {
          calls.push(received)
          return { kind: "ok", message: "skipped" }
        },
      },
    })

    // When
    await router.handle(command)

    // Then
    expect(calls).toEqual([command])
  })

  it("maps every registered command to the player control surface", async () => {
    // Given
    const controls = new FakeControls()
    const service = new PlayerCommandService(controls, radioSource)
    const options: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
      play: { query: "song" },
      radio: { genre: "indie rock" },
      remove: { id: "queue-1" },
      loop: { mode: "track" },
      volume: { volume: 125 },
      seek: { seconds: 15 },
    }

    // When
    for (const name of COMMAND_NAMES) {
      await service.execute(context({ name, options: options[name] ?? {} }))
    }

    // Then
    expect(controls.calls).toEqual([
      "play",
      "join",
      "enqueueMany:75",
      "startIfIdle",
      "pause",
      "resume",
      "skip",
      "snapshot",
      "stop",
      "snapshot",
      "snapshot",
      "remove",
      "clear",
      "shuffle",
      "loop",
      "volume",
      "seek",
      "join",
      "leave",
    ])
  })

  it("queues a 50-100 track YouTube playlist for a radio genre", async () => {
    // Given
    const controls = new FakeControls()
    const genres: string[] = []
    const service = new PlayerCommandService(controls, {
      radio: async (genre) => {
        genres.push(genre)
        return radioPlaylist
      },
    })

    // When
    const result = await service.execute(
      context({ name: "radio", options: { genre: "indie rock" } }),
    )

    // Then
    expect(genres).toEqual(["indie rock"])
    expect(controls.calls).toEqual(["join", "enqueueMany:75", "startIfIdle"])
    expect(result).toEqual({
      kind: "ok",
      message: "Queued 75 tracks from Indie Rock Essentials for indie rock radio.",
    })
  })

  it("defers play immediately and edits the response after the command finishes", async () => {
    // Given
    const replies: unknown[] = []
    const deferrals: unknown[] = []
    const edits: unknown[] = []
    const port: InteractionCommandPort = {
      commandName: "play",
      guildId: "guild-1",
      userId: "owner",
      voiceChannelId: "voice-1",
      replied: false,
      deferred: false,
      getString: (name) => (name === "query" ? "injection; $(id)" : null),
      getInteger: () => null,
      deferReply: async (payload) => {
        deferrals.push(payload)
      },
      reply: async (payload) => {
        replies.push(payload)
      },
      followUp: async () => {},
      editReply: async (payload) => {
        edits.push(payload)
      },
    }
    const calls: CommandContext[] = []
    const router = createCommandRouter({
      guildId,
      authorizedUserIds: new Set([ownerId]),
      service: {
        execute: async (received) => {
          calls.push(received)
          return { kind: "ok", message: "Now playing", track: queueItem.track }
        },
      },
    })

    // When
    await handleInteraction(port, router)

    // Then
    expect(calls.at(0)?.options).toEqual({ query: "injection; $(id)" })
    expect(deferrals).toHaveLength(1)
    expect(replies).toEqual([])
    expect(edits.at(0)).toMatchObject({
      embeds: [
        {
          data: {
            author: { name: "Now playing" },
            title: "Song",
            url: "https://youtube.example/watch?v=1",
            description: "Artist",
            footer: { text: "YouTube · Playing in your voice channel" },
          },
        },
      ],
    })
  })

  it("defers a control command before executing it and edits the acknowledgement", async () => {
    // Given
    const events: string[] = []
    const port = interactionPort({
      commandName: "pause",
      deferReply: async () => {
        events.push("deferred")
      },
      reply: async () => {
        events.push("replied")
      },
      editReply: async () => {
        events.push("edited")
      },
    })
    const router: CommandRouter = {
      handle: async () => {
        events.push("executed")
        return { kind: "ok", message: "Playback paused" }
      },
    }

    // When
    await handleInteraction(port, router)

    // Then
    expect(events).toEqual(["deferred", "executed", "edited"])
  })

  it("contains a routed command rejection, reports a redacted failure, and acknowledges once", async () => {
    // Given
    const edits: unknown[] = []
    const failures: InteractionFailure[] = []
    const port = interactionPort({
      editReply: async (payload) => {
        edits.push(payload)
      },
    })
    const router: CommandRouter = {
      handle: async () => {
        throw new Error("private routed-command detail")
      },
    }

    // When
    await handleInteractionBoundary(port, router, (failure) => failures.push(failure))

    // Then
    expect(failures).toEqual([
      {
        event: "discord.interaction.failed",
        phase: "handling",
        error: { type: "error", message: "[Redacted]" },
      },
    ])
    expect(edits).toEqual([{ content: "Something went wrong while processing that command." }])
  })

  it("contains a failure while editing the deferred error response", async () => {
    // Given
    const failures: InteractionFailure[] = []
    const port = interactionPort({
      editReply: async () => {
        throw new Error("edit transport failed")
      },
    })
    const router: CommandRouter = { handle: async () => Promise.reject(new Error("failed")) }

    // When
    await handleInteractionBoundary(port, router, (failure) => failures.push(failure))

    // Then
    expect(failures).toEqual([
      {
        event: "discord.interaction.failed",
        phase: "handling",
        error: { type: "error", message: "[Redacted]" },
      },
      {
        event: "discord.interaction.failed",
        phase: "responding",
        error: { type: "error", message: "[Redacted]" },
      },
    ])
  })

  it("uses a follow-up without double-replying when the interaction was already replied to", async () => {
    // Given
    const replies: unknown[] = []
    const followUps: unknown[] = []
    const port: InteractionCommandPort = {
      commandName: "pause",
      guildId: "guild-1",
      userId: "owner",
      voiceChannelId: "voice-1",
      replied: true,
      deferred: false,
      getString: () => null,
      getInteger: () => null,
      deferReply: async () => {
        throw new Error("already acknowledged")
      },
      reply: async (payload) => {
        replies.push(payload)
      },
      followUp: async (payload) => {
        followUps.push(payload)
      },
      editReply: async () => {},
    }
    const router: CommandRouter = { handle: async () => Promise.reject(new Error("failed")) }

    // When
    await handleInteractionBoundary(port, router, () => {})

    // Then
    expect(replies).toEqual([])
    expect(followUps).toEqual([
      { content: "Something went wrong while processing that command.", ephemeral: true },
    ])
  })

  it("edits a deferred response without double-replying", async () => {
    // Given
    const replies: unknown[] = []
    const edits: unknown[] = []
    const port = interactionPort({
      deferred: true,
      reply: async (payload) => {
        replies.push(payload)
      },
      editReply: async (payload) => {
        edits.push(payload)
      },
    })
    const router: CommandRouter = { handle: async () => Promise.reject(new Error("failed")) }

    // When
    await handleInteractionBoundary(port, router, () => {})

    // Then
    expect(replies).toEqual([])
    expect(edits).toEqual([{ content: "Something went wrong while processing that command." }])
  })

  it("edits a play deferral when playback fails after acknowledgement", async () => {
    // Given
    let deferred = false
    const replies: unknown[] = []
    const edits: unknown[] = []
    const port: InteractionCommandPort = {
      commandName: "play",
      guildId: "guild-1",
      userId: "owner",
      voiceChannelId: "voice-1",
      replied: false,
      get deferred() {
        return deferred
      },
      getString: () => "song",
      getInteger: () => null,
      deferReply: async () => {
        deferred = true
      },
      reply: async (payload) => {
        replies.push(payload)
      },
      followUp: async () => {},
      editReply: async (payload) => {
        edits.push(payload)
      },
    }
    const router: CommandRouter = {
      handle: async () => Promise.reject(new Error("playback failed")),
    }

    // When
    await handleInteractionBoundary(port, router, () => {})

    // Then
    expect(replies).toEqual([])
    expect(edits).toEqual([{ content: "Something went wrong while processing that command." }])
  })

  it("does not route non-chat interactions", async () => {
    // Given
    let calls = 0
    const router: CommandRouter = {
      handle: async () => {
        calls += 1
        return { kind: "ok", message: "should not be returned" }
      },
    }

    // When
    await handleIncomingInteraction({ kind: "non-chat-input" }, router, () => {})

    // Then
    expect(calls).toBe(0)
  })

  it("contains reporter failures while still acknowledging the command failure", async () => {
    // Given
    const edits: unknown[] = []
    const port = interactionPort({
      editReply: async (payload) => {
        edits.push(payload)
      },
    })
    const router: CommandRouter = { handle: async () => Promise.reject(new Error("failed")) }

    // When
    await handleInteractionBoundary(port, router, () => {
      throw new Error("logger transport failed")
    })

    // Then
    expect(edits).toEqual([{ content: "Something went wrong while processing that command." }])
  })
})

function interactionPort(overrides: Partial<InteractionCommandPort> = {}): InteractionCommandPort {
  let deferred = overrides.deferred ?? false
  return {
    commandName: overrides.commandName ?? "pause",
    guildId: overrides.guildId ?? "guild-1",
    userId: overrides.userId ?? "owner",
    voiceChannelId: overrides.voiceChannelId ?? "voice-1",
    replied: overrides.replied ?? false,
    get deferred() {
      return deferred
    },
    getString: overrides.getString ?? (() => null),
    getInteger: overrides.getInteger ?? (() => null),
    deferReply: async (payload) => {
      deferred = true
      await overrides.deferReply?.(payload)
    },
    reply: overrides.reply ?? (async () => {}),
    followUp: overrides.followUp ?? (async () => {}),
    editReply: overrides.editReply ?? (async () => {}),
  }
}
