import { ChannelIdSchema, GuildIdSchema, type UserId, UserIdSchema } from "@discord-music/contracts"
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Guild,
  type VoiceBasedChannel,
} from "discord.js"

import { buildApp } from "../app.js"
import { KyDiscordOAuth } from "../auth/discord-oauth.js"
import { OAuthStateStore } from "../auth/oauth-state.js"
import type { ServerConfig } from "../config.js"
import { openPersistence } from "../db/index.js"
import { secureRandom } from "../db/random.js"
import { PlayerCommandService } from "../discord/command-service.js"
import { createCommandRouter } from "../discord/commands.js"
import { registerInteractionHandler } from "../discord/interaction.js"
import { wireDiscordPresence } from "../discord/presence-publisher.js"
import { DiscordAudioResourceFactory } from "../discord/resource-factory.js"
import { DiscordVoiceGateway } from "../discord/voice-gateway.js"
import { systemClock } from "../domain/clock.js"
import { MockTidalMusicSource } from "../media/mock-tidal.js"
import { PrioritizedMusicSource } from "../media/prioritized-source.js"
import { YouTubeMusicSource } from "../media/youtube.js"
import { systemScheduler } from "../player/ports.js"
import { PlayerService } from "../player/service.js"
import { assertDependencies, checkDependencies, type DependencyStatus } from "./dependencies.js"
import { startServer } from "./server.js"

export type ProductionServer = {
  readonly address: string
  readonly shutdown: () => Promise<void>
}

export class GuildUnavailableError extends Error {
  readonly name = "GuildUnavailableError"

  constructor(readonly guildId: string) {
    super(`Discord guild is unavailable: ${guildId}`)
  }
}

export async function runProduction(
  config: ServerConfig,
  dependencies?: DependencyStatus,
): Promise<ProductionServer> {
  const checkedDependencies = dependencies ?? (await checkDependencies())
  assertDependencies(checkedDependencies)
  const guildId = GuildIdSchema.parse(config.guildId)
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  })
  const persistence = openPersistence({
    path: config.databasePath,
    clock: systemClock,
    random: secureRandom,
  })
  const settings = persistence.settings.get(guildId)
  const source = new PrioritizedMusicSource(new MockTidalMusicSource(), new YouTubeMusicSource(), {
    preference: settings.sourcePreference,
    mockTidalConnected: settings.mockTidalConnected,
  })
  const voice = new DiscordVoiceGateway({
    adapterForGuild: () => requireGuild(client, guildId).voiceAdapterCreator,
  })
  const player = new PlayerService({
    guildId,
    source,
    providers: source,
    voice,
    resourceFactory: new DiscordAudioResourceFactory(),
    clock: systemClock,
    scheduler: systemScheduler,
    nextId: secureRandom.token,
    random: Math.random,
    settings: persistence.settings,
    history: persistence.history,
  })
  const app = await buildApp({
    config,
    oauth: new KyDiscordOAuth({
      apiUrl: config.discordApiUrl,
      clientId: config.discordClientId,
      clientSecret: config.discordClientSecret,
      redirectUri: `${config.publicUrl}/auth/discord/callback`,
      guildId,
      botToken: config.discordToken,
    }),
    oauthStates: new OAuthStateStore(Date.now, secureRandom.token),
    exchangeCodes: persistence.exchangeCodes,
    sessions: persistence.sessions,
    player,
    search: source,
    guildId,
    history: persistence.history,
    voiceChannels: async () => voiceChannels(await fetchGuild(client, guildId)),
    dependencies: checkedDependencies,
    discordReady: () => client.isReady(),
    startedAtMs: Date.now(),
  })
  const authorizedUserIds = new Set<UserId>(
    [...config.authorizedUserIds].map((id) => UserIdSchema.parse(id)),
  )
  registerInteractionHandler(
    client,
    createCommandRouter({
      guildId,
      authorizedUserIds,
      service: new PlayerCommandService(player),
    }),
  )
  wireDiscordPresence(client, player, (error) => app.log.warn({ err: error }, "presence.failed"))

  try {
    await client.login(config.discordToken)
    return await startServer(app, config, {
      player,
      discord: client,
      database: persistence,
      media: source,
    })
  } catch (error) {
    await player.leave()
    await app.close()
    await source.close()
    persistence.close()
    client.destroy()
    throw error
  }
}

function requireGuild(client: Client, guildId: string): Guild {
  const guild = client.guilds.cache.get(guildId)
  if (guild === undefined) throw new GuildUnavailableError(guildId)
  return guild
}

async function fetchGuild(client: Client, guildId: string): Promise<Guild> {
  const guild = await client.guilds.fetch(guildId)
  if (guild === undefined) throw new GuildUnavailableError(guildId)
  return guild
}

async function voiceChannels(guild: Guild) {
  const channels = await guild.channels.fetch()
  return channels
    .filter(
      (channel): channel is VoiceBasedChannel =>
        channel !== null &&
        (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) &&
        channel.joinable,
    )
    .map((channel) => ({ id: ChannelIdSchema.parse(channel.id), name: channel.name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
