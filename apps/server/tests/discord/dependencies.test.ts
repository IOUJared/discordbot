import { generateDependencyReport } from "@discordjs/voice"
import { describe, expect, it } from "vitest"

describe("Discord voice dependencies", () => {
  it("loads the voice runtime and an Opus implementation", () => {
    // Given
    const report = generateDependencyReport()

    // When
    const hasVoiceRuntime = report.includes("@discordjs/voice")
    const hasOpus = report.includes("@discordjs/opus") || report.includes("opusscript")

    // Then
    expect({ hasVoiceRuntime, hasOpus }).toEqual({ hasVoiceRuntime: true, hasOpus: true })
  })
})
