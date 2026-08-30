import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sampleRate = 48_000
const channels = 2
const bytesPerSample = 2

export class GeneratedWavStore {
  private directory: Promise<string> | null = null
  private readonly paths = new Map<string, Promise<string>>()

  get(slug: string, durationSeconds: number, frequencyHz: number): Promise<string> {
    const existing = this.paths.get(slug)
    if (existing !== undefined) return existing
    const generated = this.generate(slug, durationSeconds, frequencyHz)
    this.paths.set(slug, generated)
    return generated
  }

  async close(): Promise<void> {
    const directory = this.directory
    this.paths.clear()
    this.directory = null
    if (directory !== null) await rm(await directory, { recursive: true, force: true })
  }

  private async generate(
    slug: string,
    durationSeconds: number,
    frequencyHz: number,
  ): Promise<string> {
    const directory = await this.ensureDirectory()
    const path = join(directory, `${slug}.wav`)
    await writeFile(path, createWav(durationSeconds, frequencyHz), { mode: 0o600 })
    return path
  }

  private async ensureDirectory(): Promise<string> {
    if (this.directory !== null) return this.directory
    this.directory = this.createDirectory()
    return this.directory
  }

  private async createDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "discord-music-mock-tidal-"))
    await chmod(directory, 0o700)
    return directory
  }
}

function createWav(durationSeconds: number, frequencyHz: number): Buffer {
  const frames = Math.round(durationSeconds * sampleRate)
  const dataBytes = frames * channels * bytesPerSample
  const output = Buffer.alloc(44 + dataBytes)
  output.write("RIFF", 0, "ascii")
  output.writeUInt32LE(36 + dataBytes, 4)
  output.write("WAVE", 8, "ascii")
  output.write("fmt ", 12, "ascii")
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(channels, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  output.writeUInt16LE(channels * bytesPerSample, 32)
  output.writeUInt16LE(16, 34)
  output.write("data", 36, "ascii")
  output.writeUInt32LE(dataBytes, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate
    const fade = Math.min(1, time / 0.05, (durationSeconds - time) / 0.1)
    const fundamental = Math.sin(2 * Math.PI * frequencyHz * time)
    const harmonic = Math.sin(2 * Math.PI * frequencyHz * 1.5 * time) * 0.25
    const sample = Math.round((fundamental + harmonic) * 8_000 * Math.max(0, fade))
    const offset = 44 + frame * channels * bytesPerSample
    output.writeInt16LE(sample, offset)
    output.writeInt16LE(sample, offset + bytesPerSample)
  }
  return output
}
