import type { ChannelId, GuildId, VoiceStatus } from "@discord-music/contracts"

export function createVoiceStatus(guildId: GuildId, channelId: ChannelId | null): VoiceStatus {
  return {
    guildId,
    connected: channelId !== null,
    channelId,
    muted: false,
    deafened: true,
  }
}
