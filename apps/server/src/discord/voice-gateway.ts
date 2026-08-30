import type { ChannelId, GuildId, Volume } from "@discord-music/contracts"
import {
  type AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  type DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  type VoiceConnectionState,
  VoiceConnectionStatus,
} from "@discordjs/voice"

import type {
  AudioResource,
  PlaybackCallbacks,
  VoiceGateway,
  VoiceStateEvent,
} from "../player/ports.js"
import { DiscordVoiceResource } from "./resource-factory.js"

type ManagedVoiceStatus = VoiceConnectionState["status"]

export interface ManagedVoiceConnection {
  subscribe(player: AudioPlayer): void
  on(status: ManagedVoiceStatus, listener: () => void): void
  rejoin(): boolean
  destroy(): void
}

export type VoiceConnectRequest = {
  readonly guildId: GuildId
  readonly channelId: ChannelId
  readonly adapterCreator: DiscordGatewayAdapterCreator
}

export type VoiceConnectionHandle = {
  readonly connection: ManagedVoiceConnection
  readonly ready: () => Promise<void>
}

export interface VoiceConnectionFactory {
  connect(request: VoiceConnectRequest): VoiceConnectionHandle
}

const readyTimeoutMs = 15_000

const defaultConnectionFactory: VoiceConnectionFactory = {
  connect: (request) => {
    const actual = joinVoiceChannel({ ...request, selfDeaf: true, selfMute: false })
    return {
      connection: {
        subscribe: (player) => {
          actual.subscribe(player)
        },
        on: (status, listener) => {
          actual.on(status, listener)
        },
        rejoin: () => actual.rejoin(),
        destroy: () => actual.destroy(),
      },
      ready: async () => {
        await entersState(actual, VoiceConnectionStatus.Ready, readyTimeoutMs)
      },
    }
  },
}

export type VoiceGatewayOptions = {
  readonly adapterForGuild: (guildId: GuildId) => DiscordGatewayAdapterCreator
  readonly connectionFactory?: VoiceConnectionFactory
  readonly maxReconnects?: number
}

export class InvalidAudioResourceError extends Error {
  constructor() {
    super("Voice gateway requires a Discord audio resource")
    this.name = "InvalidAudioResourceError"
  }
}

export class VoiceReadyError extends Error {
  constructor(cause: Error) {
    super("Discord voice connection did not become ready", { cause })
    this.name = "VoiceReadyError"
  }
}

export class DiscordVoiceGateway implements VoiceGateway {
  private readonly player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  })
  private readonly statusListeners = new Set<(event: VoiceStateEvent) => void>()
  private connection: ManagedVoiceConnection | null = null
  private callbacks: PlaybackCallbacks | null = null
  private activeResource: DiscordVoiceResource | null = null
  private reconnects = 0

  constructor(private readonly options: VoiceGatewayOptions) {
    this.player.on(AudioPlayerStatus.Idle, () => {
      void this.callbacks?.finished()
    })
    this.player.on("error", (event) => {
      void this.callbacks?.failed(event)
    })
  }

  async join(guildId: GuildId, channelId: ChannelId): Promise<void> {
    this.connection?.destroy()
    const handle = (this.options.connectionFactory ?? defaultConnectionFactory).connect({
      guildId,
      channelId,
      adapterCreator: this.options.adapterForGuild(guildId),
    })
    const connection = handle.connection
    this.connection = connection
    connection.subscribe(this.player)
    connection.on(VoiceConnectionStatus.Ready, () => {
      this.reconnects = 0
    })
    connection.on(VoiceConnectionStatus.Disconnected, () => this.reconnect(connection))
    try {
      await handle.ready()
    } catch (error) {
      connection.destroy()
      this.connection = null
      this.publish({ kind: "disconnected" })
      if (error instanceof Error) throw new VoiceReadyError(error)
      throw error
    }
    this.publish({ kind: "connected", channelId })
  }

  async leave(): Promise<void> {
    this.callbacks = null
    this.activeResource = null
    this.player.stop(true)
    this.connection?.destroy()
    this.connection = null
    this.publish({ kind: "disconnected" })
  }

  play(resource: AudioResource, callbacks: PlaybackCallbacks): void {
    if (!(resource instanceof DiscordVoiceResource)) throw new InvalidAudioResourceError()
    this.callbacks = callbacks
    this.activeResource = resource
    this.player.play(resource.audioResource)
  }

  pause(): boolean {
    return this.player.pause()
  }
  resume(): boolean {
    return this.player.unpause()
  }
  stop(): void {
    this.callbacks = null
    this.activeResource = null
    this.player.stop(true)
  }
  setVolume(volume: Volume): void {
    this.activeResource?.audioResource.volume?.setVolume(volume / 100)
  }

  onStatus(listener: (event: VoiceStateEvent) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private reconnect(connection: ManagedVoiceConnection): void {
    if (connection !== this.connection) return
    const maximum = this.options.maxReconnects ?? 3
    if (this.reconnects >= maximum || !connection.rejoin()) {
      connection.destroy()
      this.connection = null
      this.publish({ kind: "disconnected" })
      return
    }
    this.reconnects += 1
  }

  private publish(event: VoiceStateEvent): void {
    for (const listener of this.statusListeners) listener(event)
  }
}
