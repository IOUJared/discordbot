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
    const service = new PlayerCommandService(controls)
    const options: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
      play: { query: "song" },
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
      "pause",
      "resume",
      "skip",
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

  it("dispatches a chat-input interaction and replies with an embed", async () => {
    // Given
    const replies: unknown[] = []
    const port: InteractionCommandPort = {
      commandName: "play",
      guildId: "guild-1",
      userId: "owner",
      voiceChannelId: "voice-1",
      replied: false,
      deferred: false,
      getString: (name) => (name === "query" ? "injection; $(id)" : null),
      getInteger: () => null,
      reply: async (payload) => {
        replies.push(payload)
      },
      followUp: async () => {},
      editReply: async () => {},
    }
    const calls: CommandContext[] = []
    const router = createCommandRouter({
      guildId,
      authorizedUserIds: new Set([ownerId]),
      service: {
        execute: async (received) => {
          calls.push(received)
          return { kind: "ok", message: "Queued" }
        },
      },
    })

    // When
    await handleInteraction(port, router)

    // Then
    expect(calls.at(0)?.options).toEqual({ query: "injection; $(id)" })
    expect(replies.at(0)).toMatchObject({ embeds: [{ data: { description: "Queued" } }] })
  })

  it("contains a routed command rejection, reports a redacted failure, and acknowledges once", async () => {
    // Given
    const replies: unknown[] = []
    const failures: InteractionFailure[] = []
    const port = interactionPort({
      reply: async (payload) => {
        replies.push(payload)
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
    expect(replies).toEqual([
      { content: "Something went wrong while processing that command.", ephemeral: true },
    ])
  })

  it("contains a failure while sending the initial reply", async () => {
    // Given
    const failures: InteractionFailure[] = []
    const port = interactionPort({
      reply: async () => {
        throw new Error("reply transport failed")
      },
    })
    const router: CommandRouter = { handle: async () => ({ kind: "ok", message: "Queued" }) }

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
    const port = interactionPort({
      replied: true,
      reply: async (payload) => {
        replies.push(payload)
      },
      followUp: async (payload) => {
        followUps.push(payload)
      },
    })
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
    const replies: unknown[] = []
    const port = interactionPort({
      reply: async (payload) => {
        replies.push(payload)
      },
    })
    const router: CommandRouter = { handle: async () => Promise.reject(new Error("failed")) }

    // When
    await handleInteractionBoundary(port, router, () => {
      throw new Error("logger transport failed")
    })

    // Then
    expect(replies).toEqual([
      { content: "Something went wrong while processing that command.", ephemeral: true },
    ])
  })
})

function interactionPort(overrides: Partial<InteractionCommandPort> = {}): InteractionCommandPort {
  return {
    commandName: "pause",
    guildId: "guild-1",
    userId: "owner",
    voiceChannelId: "voice-1",
    replied: false,
    deferred: false,
    getString: () => null,
    getInteger: () => null,
    reply: async () => {},
    followUp: async () => {},
    editReply: async () => {},
    ...overrides,
  }
}
