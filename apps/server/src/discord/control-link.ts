import { ChannelType, type Client } from "discord.js"

export type ControlChannelCandidate = {
  readonly id: string
  readonly position: number
  readonly system: boolean
}

/**
 * The control link should land in the channel the room actually talks in: the
 * guild's system channel when it has one, otherwise the first sendable text
 * channel from the top of the list.
 */
export function rankControlChannels(
  candidates: readonly ControlChannelCandidate[],
): readonly string[] {
  return [...candidates]
    .sort(
      (left, right) => Number(right.system) - Number(left.system) || left.position - right.position,
    )
    .map((candidate) => candidate.id)
}

export interface ControlLinkPort {
  candidates(): readonly ControlChannelCandidate[]
  send(channelId: string, content: string): Promise<void>
}

export interface ControlLinkSource {
  voiceStatus(): { readonly connected: boolean; readonly channelId: string | null }
  onStateChange(listener: () => void): () => void
}

export class ControlLinkError extends Error {
  constructor(
    readonly kind: "no_channel" | "send_failed",
    cause?: Error,
  ) {
    super(
      kind === "no_channel"
        ? "No text channel accepts the control link"
        : "Control link post failed",
      { cause },
    )
    this.name = "ControlLinkError"
  }
}

export function wireControlLink(
  port: ControlLinkPort,
  source: ControlLinkSource,
  url: string,
  preferredChannelId?: string,
  onError: (error: ControlLinkError) => void = () => undefined,
): () => void {
  let announcedChannelId: string | null = null
  const publish = (): void => {
    const voice = source.voiceStatus()
    if (!voice.connected || voice.channelId === null) {
      announcedChannelId = null
      return
    }
    if (voice.channelId === announcedChannelId) return
    announcedChannelId = voice.channelId
    const target = preferredChannelId ?? rankControlChannels(port.candidates())[0]
    if (target === undefined) {
      onError(new ControlLinkError("no_channel"))
      return
    }
    void port
      .send(target, `Control the bot: ${url}`)
      .catch((error: unknown) =>
        onError(new ControlLinkError("send_failed", error instanceof Error ? error : undefined)),
      )
  }
  return source.onStateChange(publish)
}

export function wireDiscordControlLink(
  client: Client,
  guildId: string,
  source: ControlLinkSource,
  url: string,
  preferredChannelId?: string,
  onError?: (error: ControlLinkError) => void,
): () => void {
  const port: ControlLinkPort = {
    candidates: () => {
      const guild = client.guilds.cache.get(guildId)
      if (guild === undefined) return []
      return [...guild.channels.cache.values()]
        .filter(
          (channel) =>
            (channel.type === ChannelType.GuildText ||
              channel.type === ChannelType.GuildAnnouncement) &&
            channel.isSendable(),
        )
        .map((channel) => ({
          id: channel.id,
          position: channel.rawPosition,
          system: channel.id === guild.systemChannelId,
        }))
    },
    send: async (channelId, content) => {
      const guild = client.guilds.cache.get(guildId)
      const channel = guild?.channels.cache.get(channelId)
      if (channel === undefined || !channel.isTextBased() || !channel.isSendable()) {
        throw new ControlLinkError("no_channel")
      }
      await channel.send({ content, allowedMentions: { parse: [] } })
    },
  }
  return onError === undefined
    ? wireControlLink(port, source, url, preferredChannelId)
    : wireControlLink(port, source, url, preferredChannelId, onError)
}
