import { generateDependencyReport } from "@discordjs/voice"
import { describe, expect, it } from "vitest"

describe("Discord voice dependencies", () => {
  it("loads the voice runtime and the native Opus implementation", () => {
    // Given
    const report = generateDependencyReport()

    // When
    const hasVoiceRuntime = report.includes("@discordjs/voice")
    const hasNativeOpus = !report.includes("@discordjs/opus: not found")

    // Then
    expect({ hasVoiceRuntime, hasNativeOpus }).toEqual({
      hasVoiceRuntime: true,
      hasNativeOpus: true,
    })
  })
})
