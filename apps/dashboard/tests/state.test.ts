import { describe, expect, it } from "vitest"

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
})
