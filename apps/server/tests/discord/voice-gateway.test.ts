import { ChannelIdSchema, GuildIdSchema } from "@discord-music/contracts"
import { VoiceConnectionStatus } from "@discordjs/voice"
import { describe, expect, it } from "vitest"

import {
  DiscordVoiceGateway,
  type ManagedVoiceConnection,
  type VoiceConnectionFactory,
} from "../../src/discord/voice-gateway.js"

class FakeConnection implements ManagedVoiceConnection {
  readonly listeners = new Map<string, () => void>()
  destroyed = false
  rejoins = 0
  subscribe() {}
  on(status: string, listener: () => void) {
    this.listeners.set(status, listener)
  }
  rejoin() {
    this.rejoins += 1
    return true
  }
  destroy() {
    this.destroyed = true
  }
  emit(status: string) {
    this.listeners.get(status)?.()
  }
}

class ReadyGate {
  private releaseWait: () => void = () => undefined
  readonly wait = new Promise<void>((resolve) => {
    this.releaseWait = resolve
  })
  release() {
    this.releaseWait()
  }
}

const adapterForGuild = () => () => ({ sendPayload: () => true, destroy: () => undefined })

describe("DiscordVoiceGateway lifecycle", () => {
  it("does not resolve join until the connection reaches Ready", async () => {
    // Given
    const connection = new FakeConnection()
    const gate = new ReadyGate()
    const factory: VoiceConnectionFactory = {
      connect: () => ({ connection, ready: () => gate.wait }),
    }
    const gateway = new DiscordVoiceGateway({
      adapterForGuild,
      connectionFactory: factory,
    })
    let joined = false

    // When
    const pending = gateway
      .join(GuildIdSchema.parse("guild-1"), ChannelIdSchema.parse("voice-1"))
      .then(() => {
        joined = true
      })
    await Promise.resolve()
    const beforeReady = joined
    gate.release()
    await pending

    // Then
    expect({ beforeReady, joined }).toEqual({ beforeReady: false, joined: true })
  })

  it("publishes disconnected after bounded reconnect exhaustion", async () => {
    // Given
    const connection = new FakeConnection()
    const factory: VoiceConnectionFactory = {
      connect: () => ({ connection, ready: async () => undefined }),
    }
    const gateway = new DiscordVoiceGateway({
      adapterForGuild,
      connectionFactory: factory,
      maxReconnects: 1,
    })
    const statuses: string[] = []
    gateway.onStatus((event) => statuses.push(event.kind))
    await gateway.join(GuildIdSchema.parse("guild-1"), ChannelIdSchema.parse("voice-1"))

    // When
    connection.emit(VoiceConnectionStatus.Disconnected)
    connection.emit(VoiceConnectionStatus.Disconnected)

    // Then
    expect(statuses).toEqual(["connected", "disconnected"])
    expect(connection.destroyed).toBe(true)
  })
})
