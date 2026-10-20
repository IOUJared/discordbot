import { describe, expect, it, vi } from "vitest"

import {
  type ControlChannelCandidate,
  type ControlLinkError,
  type ControlLinkSource,
  rankControlChannels,
  wireControlLink,
} from "../../src/discord/control-link.js"

function harness(
  candidates: readonly ControlChannelCandidate[] = [{ id: "text-1", position: 1, system: false }],
) {
  let connected = false
  let channelId: string | null = null
  let listener: (() => void) | null = null
  const send = vi.fn(async () => undefined)
  const source: ControlLinkSource = {
    voiceStatus: () => ({ connected, channelId }),
    onStateChange: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
  }
  const enter = (id: string): void => {
    connected = true
    channelId = id
    listener?.()
  }
  const leave = (): void => {
    connected = false
    channelId = null
    listener?.()
  }
  const port = { candidates: () => candidates, send }
  return { enter, leave, port, send, source }
}

describe("control link", () => {
  it("Given a system channel When channels are ranked Then it leads the list", () => {
    // Given
    const candidates: readonly ControlChannelCandidate[] = [
      { id: "general", position: 0, system: false },
      { id: "lobby", position: 2, system: true },
      { id: "music", position: 1, system: false },
    ]

    // When
    const ranked = rankControlChannels(candidates)

    // Then
    expect(ranked).toEqual(["lobby", "general", "music"])
  })

  it("Given the bot joins voice When state changes Then the control URL is posted once", async () => {
    // Given
    const { enter, port, send, source } = harness()
    wireControlLink(port, source, "https://music.example.com/")

    // When
    enter("voice-1")
    enter("voice-1")

    // Then
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("text-1", "Control the bot: https://music.example.com/")
  })

  it("Given the bot leaves and rejoins When it connects again Then the link is posted again", () => {
    // Given
    const { enter, leave, port, send, source } = harness()
    wireControlLink(port, source, "https://music.example.com/")

    // When
    enter("voice-1")
    leave()
    enter("voice-2")

    // Then
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("Given a configured channel When the bot joins Then that channel wins", () => {
    // Given
    const candidates: readonly ControlChannelCandidate[] = [
      { id: "system", position: 0, system: true },
      { id: "music", position: 3, system: false },
    ]
    const { enter, port, send, source } = harness(candidates)
    wireControlLink(port, source, "https://music.example.com/", "music")

    // When
    enter("voice-1")

    // Then
    expect(send).toHaveBeenCalledWith("music", "Control the bot: https://music.example.com/")
  })

  it("Given no sendable channel When the bot joins Then the failure is reported", () => {
    // Given
    const { enter, port, source } = harness([])
    const errors: ControlLinkError[] = []
    wireControlLink(port, source, "https://music.example.com/", undefined, (error) =>
      errors.push(error),
    )

    // When
    enter("voice-1")

    // Then
    expect(errors.map((error) => error.kind)).toEqual(["no_channel"])
  })
})
