import { describe, expect, it } from "vitest"

import { TrackSchema } from "../src/lib/domain/schemas.js"
import {
  controlsFor,
  parseSnapshotMessage,
  parseSocketMessage,
  requireVoiceSelection,
} from "../src/lib/domain/state.js"

describe("state derivation", () => {
  it("Given no current item When controls derive Then playback commands are disabled", () => {
    expect(
      controlsFor({
        hasCurrent: false,
        connected: true,
        paused: false,
        busy: false,
        seekable: false,
      }).canPause,
    ).toBe(false)
  })

  it("Given active unseekable media When controls derive Then seeking is disabled", () => {
    expect(
      controlsFor({
        hasCurrent: true,
        connected: true,
        paused: false,
        busy: false,
        seekable: false,
      }).canSeek,
    ).toBe(false)
  })

  it("Given a playback failure websocket event When parsed Then its safe notification is accepted", () => {
    const message = {
      version: 1,
      type: "playback.failed",
      payload: {
        guildId: "guild-1",
        queueItemId: "queue-1",
        trackId: "track-1",
        provider: "youtube",
        title: "Unavailable track",
        artist: "Artist",
        message: "Playback failed; skipped to the next track.",
      },
    }

    expect(parseSocketMessage(message)).toMatchObject({ success: true, data: message })
  })

  it("Given a voice membership websocket event When parsed Then live channel counts are accepted", () => {
    const message = {
      version: 1,
      type: "voice.channels",
      payload: { channels: [{ id: "voice-1", name: "General", memberCount: 4 }] },
    }

    expect(parseSocketMessage(message)).toMatchObject({ success: true, data: message })
  })

  it("Given disconnected voice and no selection When adding Then a channel is required", () => {
    expect(requireVoiceSelection(false, "")).toBe(false)
  })

  it("Given malformed websocket input When parsed Then it is rejected", () => {
    expect(
      parseSnapshotMessage({ version: 1, type: "state.snapshot", payload: { bad: true } }).success,
    ).toBe(false)
  })

  it("Given a provider unsupported by the shared player contract When a track is parsed Then it is rejected", () => {
    expect(
      TrackSchema.safeParse({
        id: "spotify-track",
        provider: "spotify",
        title: "Unsupported provider",
        artist: "Fixture",
        url: "https://example.com/track",
        durationMs: 1_000,
      }).success,
    ).toBe(false)
  })
})
