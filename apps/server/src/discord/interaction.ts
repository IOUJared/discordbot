import { ChannelIdSchema, GuildIdSchema, type Track, UserIdSchema } from "@discord-music/contracts"
import {
  type Client,
  EmbedBuilder,
  Events,
  GuildMember,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  MessageFlags,
} from "discord.js"
import { z } from "zod"

import {
  COMMAND_NAMES,
  type CommandContext,
  type CommandName,
  type CommandRouter,
} from "./commands.js"

const commandNameSchema = z.enum(COMMAND_NAMES)

const commandLabels: Readonly<Record<CommandName, string>> = {
  play: "Now playing",
  radio: "Radio queued",
  pause: "Playback paused",
  resume: "Playback resumed",
  skip: "Track skipped",
  stop: "Playback stopped",
  queue: "Current queue",
  nowplaying: "Now playing",
  remove: "Queue updated",
  clear: "Queue cleared",
  shuffle: "Queue shuffled",
  loop: "Loop mode updated",
  volume: "Volume updated",
  seek: "Playback position updated",
  join: "Voice connected",
  leave: "Voice disconnected",
}

export interface InteractionCommandPort {
  readonly commandName: string
  readonly guildId: string | null
  readonly userId: string
  readonly voiceChannelId: string | null
  readonly replied: boolean
  readonly deferred: boolean
  getString(name: string): string | null
  getInteger(name: string): number | null
  deferReply(payload: InteractionDeferReplyOptions): Promise<unknown>
  reply(payload: InteractionReplyOptions): Promise<unknown>
  followUp(payload: InteractionReplyOptions): Promise<unknown>
  editReply(payload: InteractionEditReplyOptions): Promise<unknown>
}

export type InteractionFailure = {
  readonly event: "discord.interaction.failed"
  readonly phase: "handling" | "responding"
  readonly error: {
    readonly type: "error" | "unknown"
    readonly message: "[Redacted]"
  }
}

export type InteractionFailureReporter = (failure: InteractionFailure) => void

export type IncomingInteraction =
  | { readonly kind: "chat-input"; readonly port: InteractionCommandPort }
  | { readonly kind: "non-chat-input" }

export class InteractionInputError extends Error {
  constructor(readonly field: string) {
    super(`Discord interaction field is missing or invalid: ${field}`)
    this.name = "InteractionInputError"
  }
}

function requiredString(port: InteractionCommandPort, name: string): string {
  const value = port.getString(name)
  if (value === null) throw new InteractionInputError(name)
  return value
}

function requiredInteger(port: InteractionCommandPort, name: string): number {
  const value = port.getInteger(name)
  if (value === null) throw new InteractionInputError(name)
  return value
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported interaction command: ${String(value)}`)
}

function interactionOptions(name: CommandName, port: InteractionCommandPort) {
  switch (name) {
    case "play":
      return { query: requiredString(port, "query") }
    case "radio":
      return { genre: requiredString(port, "genre") }
    case "remove":
      return { id: requiredString(port, "id") }
    case "loop":
      return { mode: requiredString(port, "mode") }
    case "volume":
      return { volume: requiredInteger(port, "volume") }
    case "seek":
      return { seconds: requiredInteger(port, "seconds") }
    case "pause":
    case "resume":
    case "skip":
    case "stop":
    case "queue":
    case "nowplaying":
    case "clear":
    case "shuffle":
    case "join":
    case "leave":
      return {}
    default:
      return assertNever(name)
  }
}

export async function handleInteraction(
  port: InteractionCommandPort,
  router: CommandRouter,
): Promise<void> {
  const name = commandNameSchema.parse(port.commandName)
  await port.deferReply({ flags: MessageFlags.Ephemeral })
  const context: CommandContext = {
    name,
    guildId: GuildIdSchema.parse(port.guildId),
    userId: UserIdSchema.parse(port.userId),
    voiceChannelId:
      port.voiceChannelId === null ? null : ChannelIdSchema.parse(port.voiceChannelId),
    options: interactionOptions(name, port),
  }
  const result = await router.handle(context)
  await port.editReply({ embeds: [commandEmbed(name, result)] })
}

function commandEmbed(name: CommandName, result: Awaited<ReturnType<CommandRouter["handle"]>>) {
  if (result.kind === "ok" && result.track !== undefined) return nowPlayingEmbed(result.track)
  const author =
    result.kind === "rejected"
      ? "Command not authorized"
      : result.kind === "invalid"
        ? "Action needed"
        : commandLabels[name]
  const description =
    result.kind === "rejected" ? "You do not have permission to control this bot." : result.message
  return new EmbedBuilder().setAuthor({ name: author }).setDescription(description)
}

function nowPlayingEmbed(track: Track): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "Now playing" })
    .setTitle(track.title)
    .setURL(track.url)
    .setDescription(track.artist)
    .setFooter({ text: "YouTube · Playing in your voice channel" })
  if (track.artworkUrl !== undefined) embed.setThumbnail(track.artworkUrl)
  return embed
}

const failureMessage = "Something went wrong while processing that command."

function reportFailure(
  reporter: InteractionFailureReporter,
  phase: InteractionFailure["phase"],
  error: unknown,
): void {
  const failure: InteractionFailure = {
    event: "discord.interaction.failed",
    phase,
    error: {
      type: error instanceof Error ? "error" : "unknown",
      message: "[Redacted]",
    },
  }
  try {
    reporter(failure)
  } catch {
    return
  }
}

async function replyToFailure(port: InteractionCommandPort): Promise<void> {
  if (port.deferred) {
    await port.editReply({ content: failureMessage })
    return
  }
  if (port.replied) {
    await port.followUp({ content: failureMessage, ephemeral: true })
    return
  }
  await port.reply({ content: failureMessage, ephemeral: true })
}

export async function handleInteractionBoundary(
  port: InteractionCommandPort,
  router: CommandRouter,
  reporter: InteractionFailureReporter,
): Promise<void> {
  try {
    await handleInteraction(port, router)
  } catch (error) {
    const handlingError =
      error instanceof Error ? error : new Error("Unknown Discord interaction failure")
    reportFailure(reporter, "handling", handlingError)
    try {
      await replyToFailure(port)
    } catch (responseError) {
      const replyError =
        responseError instanceof Error
          ? responseError
          : new Error("Unknown Discord interaction response failure")
      reportFailure(reporter, "responding", replyError)
    }
  }
}

export async function handleIncomingInteraction(
  interaction: IncomingInteraction,
  router: CommandRouter,
  reporter: InteractionFailureReporter,
): Promise<void> {
  if (interaction.kind === "non-chat-input") return
  await handleInteractionBoundary(interaction.port, router, reporter)
}

export function registerInteractionHandler(
  client: Client,
  router: CommandRouter,
  reporter: InteractionFailureReporter,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      void handleIncomingInteraction({ kind: "non-chat-input" }, router, reporter)
      return
    }
    const voiceChannelId =
      interaction.member instanceof GuildMember ? interaction.member.voice.channelId : null
    void handleIncomingInteraction(
      {
        kind: "chat-input",
        port: {
          commandName: interaction.commandName,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          voiceChannelId,
          get replied() {
            return interaction.replied
          },
          get deferred() {
            return interaction.deferred
          },
          getString: (name) => interaction.options.getString(name),
          getInteger: (name) => interaction.options.getInteger(name),
          deferReply: (payload) => interaction.deferReply(payload),
          reply: (payload) => interaction.reply(payload),
          followUp: (payload) => interaction.followUp(payload),
          editReply: (payload) => interaction.editReply(payload),
        },
      },
      router,
      reporter,
    )
  })
}
