import { ChannelIdSchema, GuildIdSchema, UserIdSchema } from "@discord-music/contracts"
import {
  type Client,
  EmbedBuilder,
  Events,
  GuildMember,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
} from "discord.js"
import { z } from "zod"

import {
  COMMAND_NAMES,
  type CommandContext,
  type CommandName,
  type CommandRouter,
} from "./commands.js"

const commandNameSchema = z.enum(COMMAND_NAMES)

export interface InteractionCommandPort {
  readonly commandName: string
  readonly guildId: string | null
  readonly userId: string
  readonly voiceChannelId: string | null
  readonly replied: boolean
  readonly deferred: boolean
  getString(name: string): string | null
  getInteger(name: string): number | null
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
  const context: CommandContext = {
    name,
    guildId: GuildIdSchema.parse(port.guildId),
    userId: UserIdSchema.parse(port.userId),
    voiceChannelId:
      port.voiceChannelId === null ? null : ChannelIdSchema.parse(port.voiceChannelId),
    options: interactionOptions(name, port),
  }
  const result = await router.handle(context)
  const description = result.kind === "rejected" ? "Command not authorized" : result.message
  await port.reply({ embeds: [new EmbedBuilder().setDescription(description)], ephemeral: true })
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
    reportFailure(reporter, "handling", error)
    try {
      await replyToFailure(port)
    } catch (responseError) {
      reportFailure(reporter, "responding", responseError)
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
          replied: interaction.replied,
          deferred: interaction.deferred,
          getString: (name) => interaction.options.getString(name),
          getInteger: (name) => interaction.options.getInteger(name),
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
