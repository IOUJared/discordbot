import type { GuildId, PlaybackFailureNotification, QueueItem } from "@discord-music/contracts"

export type PlaybackFailureLog = {
  readonly event: "player.playback.failed"
  readonly guildId: GuildId
  readonly queueItemId: QueueItem["id"]
  readonly trackId: QueueItem["track"]["id"]
  readonly provider: QueueItem["track"]["provider"]
  readonly error: {
    readonly type: "error" | "unknown"
    readonly message: "[Redacted]"
  }
}

export type PlaybackFailureReporter = (failure: PlaybackFailureLog) => void
export type PlaybackFailureListener = (notification: PlaybackFailureNotification) => void

export class PlaybackFailurePublisher {
  private readonly listeners = new Set<PlaybackFailureListener>()

  constructor(
    private readonly guildId: GuildId,
    private readonly reporter: PlaybackFailureReporter = () => undefined,
  ) {}

  subscribe(listener: PlaybackFailureListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(item: QueueItem, error: unknown): void {
    const notification: PlaybackFailureNotification = {
      guildId: this.guildId,
      queueItemId: item.id,
      trackId: item.track.id,
      provider: item.track.provider,
      title: item.track.title,
      artist: item.track.artist,
      message: "Playback failed; skipped to the next track.",
    }
    this.report({
      event: "player.playback.failed",
      guildId: this.guildId,
      queueItemId: item.id,
      trackId: item.track.id,
      provider: item.track.provider,
      error: {
        type: error instanceof Error ? "error" : "unknown",
        message: "[Redacted]",
      },
    })
    this.publishToListeners(notification)
  }

  private report(failure: PlaybackFailureLog): void {
    try {
      this.reporter(failure)
    } catch {
      return
    }
  }

  private publishToListeners(notification: PlaybackFailureNotification): void {
    for (const listener of this.listeners) {
      this.notify(listener, notification)
    }
  }

  private notify(
    listener: PlaybackFailureListener,
    notification: PlaybackFailureNotification,
  ): void {
    try {
      listener(notification)
    } catch {
      return
    }
  }
}
