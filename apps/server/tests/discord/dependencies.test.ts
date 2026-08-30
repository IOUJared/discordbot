import { OpusEncoder } from "@discordjs/opus"
import { generateDependencyReport } from "@discordjs/voice"
import { describe, expect, it } from "vitest"

describe("Discord voice dependencies", () => {
  it("loads the voice runtime and the native Opus implementation", () => {
    // Given
    const report = generateDependencyReport()
    const pcmFrame = Buffer.alloc(3_840)

    // When
    const hasVoiceRuntime = report.includes("@discordjs/voice")
    const opusPacket = new OpusEncoder(48_000, 2).encode(pcmFrame)

    // Then
    expect(hasVoiceRuntime).toBe(true)
    expect(opusPacket.byteLength).toBeGreaterThan(0)
  })
})
