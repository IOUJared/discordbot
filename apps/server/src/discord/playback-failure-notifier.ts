import type { PlaybackFailureNotification, UserId } from "@discord-music/contracts"
import type { Client } from "discord.js"

export interface PlaybackFailureSource {
  onPlaybackFailure(listener: (event: PlaybackFailureNotification) => void): () => void
}

export interface PlaybackFailureMessagePort {
  send(userId: UserId, message: string): Promise<void>
}

export class PlaybackFailureNotifyError extends Error {
  constructor() {
    super("Discord playback failure notification failed")
    this.name = "PlaybackFailureNotifyError"
  }
}

export function wirePlaybackFailureNotifier(
  source: PlaybackFailureSource,
  port: PlaybackFailureMessagePort,
  ownerId: UserId,
  onError: (error: PlaybackFailureNotifyError) => void = () => undefined,
): () => void {
  return source.onPlaybackFailure((event) => {
    void Promise.resolve()
      .then(() =>
        port.send(
          ownerId,
          `Playback failed for “${event.title}” by ${event.artist}. It was skipped.`,
        ),
      )
      .catch(() => {
        try {
          onError(new PlaybackFailureNotifyError())
        } catch {
          return
        }
      })
  })
}

export function wireDiscordPlaybackFailureNotifier(
  client: Client,
  source: PlaybackFailureSource,
  ownerId: UserId,
  onError?: (error: PlaybackFailureNotifyError) => void,
): () => void {
  const port: PlaybackFailureMessagePort = {
    send: async (userId, message) => {
      const user = await client.users.fetch(userId)
      await user.send(message)
    },
  }
  return wirePlaybackFailureNotifier(source, port, ownerId, onError)
}
