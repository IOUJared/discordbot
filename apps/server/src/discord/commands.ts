import type { ChannelId, GuildId, UserId } from "@discord-music/contracts"
import {
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from "discord.js"

export const COMMAND_NAMES = [
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
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

export type CommandContext = {
  readonly guildId: GuildId
  readonly userId: UserId
  readonly voiceChannelId: ChannelId | null
  readonly name: CommandName
  readonly options: Readonly<Record<string, string | number>>
}

export type CommandResult =
  | { readonly kind: "ok"; readonly message: string }
  | { readonly kind: "rejected"; readonly reason: "guild" | "user" }
  | { readonly kind: "invalid"; readonly message: string }

export interface CommandService {
  execute(context: CommandContext): Promise<CommandResult>
}

export interface CommandRouter {
  handle(context: CommandContext): Promise<CommandResult>
}

export type CommandRouterOptions = {
  readonly guildId: GuildId
  readonly authorizedUserIds: ReadonlySet<UserId>
  readonly service: CommandService
}

export function createCommandRouter(options: CommandRouterOptions): CommandRouter {
  return {
    handle: async (context: CommandContext): Promise<CommandResult> => {
      if (context.guildId !== options.guildId) return { kind: "rejected", reason: "guild" }
      if (!options.authorizedUserIds.has(context.userId)) {
        return { kind: "rejected", reason: "user" }
      }
      return options.service.execute(context)
    },
  }
}

const simpleCommands = [
  "pause",
  "resume",
  "skip",
  "stop",
  "queue",
  "nowplaying",
  "clear",
  "shuffle",
  "join",
  "leave",
] as const

const simpleDefinitions = simpleCommands.map((name) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(`Control music: ${name}`)
    .setDMPermission(false)
    .toJSON(),
)

const definitions = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Search or play a URL")
    .setDMPermission(false)
    .addStringOption((option) =>
      option.setName("query").setDescription("Search text or URL").setRequired(true),
    )
    .toJSON(),
  ...simpleDefinitions,
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a queued item")
    .setDMPermission(false)
    .addStringOption((option) =>
      option.setName("id").setDescription("Queue item ID").setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set loop mode")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "off", value: "off" },
          { name: "track", value: "track" },
          { name: "queue", value: "queue" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set volume")
    .setDMPermission(false)
    .addIntegerOption((option) =>
      option
        .setName("volume")
        .setDescription("Volume percent")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Seek in the current track")
    .setDMPermission(false)
    .addIntegerOption((option) =>
      option
        .setName("seconds")
        .setDescription("Position in seconds")
        .setRequired(true)
        .setMinValue(0),
    )
    .toJSON(),
] satisfies readonly RESTPostAPIChatInputApplicationCommandsJSONBody[]

const byCommandOrder = new Map(definitions.map((definition) => [definition.name, definition]))

export const COMMAND_DEFINITIONS: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[] =
  COMMAND_NAMES.map((name) => {
    const definition = byCommandOrder.get(name)
    if (definition === undefined) throw new RangeError(`Missing slash definition: ${name}`)
    return definition
  })
