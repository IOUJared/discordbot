import {
  GuildIdSchema,
  QueueItemIdSchema,
  TrackIdSchema,
  UserIdSchema,
} from "@discord-music/contracts"
import { describe, expect, it, vi } from "vitest"

import {
  type PlaybackFailureNotifyError,
  wirePlaybackFailureNotifier,
} from "../../src/discord/playback-failure-notifier.js"

const failure = {
  guildId: GuildIdSchema.parse("guild-1"),
  queueItemId: QueueItemIdSchema.parse("queue-1"),
  trackId: TrackIdSchema.parse("track-1"),
  provider: "youtube" as const,
  title: "Unavailable track",
  artist: "Artist",
  message: "Playback failed; skipped to the next track." as const,
}

describe("playback failure Discord notifier", () => {
  it("Given a playback failure When emitted Then the owner receives a bounded safe DM", async () => {
    // Given
    let listener: (event: typeof failure) => void = () => undefined
    let deliveryComplete = (): void => undefined
    const delivered = new Promise<void>((resolve) => {
      deliveryComplete = resolve
    })
    const send = vi.fn(async () => deliveryComplete())
    wirePlaybackFailureNotifier(
      {
        onPlaybackFailure: (next) => {
          listener = next
          return () => undefined
        },
      },
      { send },
      UserIdSchema.parse("owner-1"),
    )

    // When
    listener(failure)
    await delivered

    // Then
    expect(send).toHaveBeenCalledWith(
      UserIdSchema.parse("owner-1"),
      "Playback failed for “Unavailable track” by Artist. It was skipped.",
    )
  })

  it("Given Discord rejects a failure DM When emitted Then rejection is reported and contained", async () => {
    // Given
    let listener: (event: typeof failure) => void = () => undefined
    const errors: PlaybackFailureNotifyError[] = []
    let reportComplete = (): void => undefined
    const reported = new Promise<void>((resolve) => {
      reportComplete = resolve
    })
    wirePlaybackFailureNotifier(
      {
        onPlaybackFailure: (next) => {
          listener = next
          return () => undefined
        },
      },
      {
        send: async () => {
          throw new Error("secret transport detail")
        },
      },
      UserIdSchema.parse("owner-1"),
      (error) => {
        errors.push(error)
        reportComplete()
      },
    )

    // When
    listener(failure)
    await reported

    // Then
    expect(errors).toEqual([expect.objectContaining({ name: "PlaybackFailureNotifyError" })])
    expect(JSON.stringify(errors)).not.toContain("secret transport detail")
  })
})
