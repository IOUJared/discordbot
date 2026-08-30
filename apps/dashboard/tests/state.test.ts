import { describe, expect, it } from "vitest"

import { TrackSchema } from "../src/lib/domain/schemas.js"
import {
  controlsFor,
  parseSnapshotMessage,
  requireVoiceSelection,
} from "../src/lib/domain/state.js"

describe("state derivation", () => {
  it("Given no current item When controls derive Then playback commands are disabled", () => {
    expect(
      controlsFor({ hasCurrent: false, connected: true, paused: false, busy: false }).canPause,
    ).toBe(false)
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
