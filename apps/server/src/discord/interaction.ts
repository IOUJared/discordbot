import { ChannelIdSchema, GuildIdSchema, UserIdSchema } from "@discord-music/contracts"
import {
  type Client,
  EmbedBuilder,
  Events,
  GuildMember,
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
  getString(name: string): string | null
  getInteger(name: string): number | null
  reply(payload: InteractionReplyOptions): Promise<unknown>
}

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

export function registerInteractionHandler(client: Client, router: CommandRouter): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return
    const voiceChannelId =
      interaction.member instanceof GuildMember ? interaction.member.voice.channelId : null
    void handleInteraction(
      {
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        voiceChannelId,
        getString: (name) => interaction.options.getString(name),
        getInteger: (name) => interaction.options.getInteger(name),
        reply: (payload) => interaction.reply(payload),
      },
      router,
    )
  })
}
