import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { BitrateKbpsSchema } from "@discord-music/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  bufferDirectStream: vi.fn(),
  openDirectStream: vi.fn(),
  openSeekableMediaProxy: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }))
vi.mock("../../src/discord/direct-stream.js", () => ({
  bufferDirectStream: mocks.bufferDirectStream,
  openDirectStream: mocks.openDirectStream,
  openSeekableMediaProxy: mocks.openSeekableMediaProxy,
}))

const { bufferedAfterMs, DiscordAudioResourceFactory } = await import(
  "../../src/discord/resource-factory.js"
)

import { RemoteMediaUrlSchema } from "../../src/media/media-url-policy.js"
import type { LocalPlayableMedia, RemotePlayableMedia } from "../../src/media/types.js"

const remoteMedia: RemotePlayableMedia = {
  kind: "remote",
  url: RemoteMediaUrlSchema.parse(
    "https://rr1---sn-example.googlevideo.com/videoplayback?itag=251",
  ),
  headers: { "User-Agent": "Mozilla/5.0" },
  container: "webm",
  codec: "opus",
  bitrateKbps: BitrateKbpsSchema.parse(128),
  seekable: true,
}

const localMedia: LocalPlayableMedia = {
  kind: "local",
  url: "/tmp/track.webm",
  headers: {},
  container: "webm",
  codec: "opus",
  bitrateKbps: BitrateKbpsSchema.parse(128),
  seekable: true,
}

function fakeChild() {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  return Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    exitCode: null as number | null,
    kill: vi.fn(),
  })
}

describe("audio resource factory", () => {
  beforeEach(() => {
    mocks.bufferDirectStream.mockReset()
    mocks.openDirectStream.mockReset()
    mocks.openSeekableMediaProxy.mockReset()
    mocks.spawn.mockReset()
    mocks.bufferDirectStream.mockImplementation(async (source: PassThrough) => source)
    mocks.openDirectStream.mockImplementation(async () => new PassThrough())
  })

  it("Given a long remote track When a resource is created Then ffmpeg reads it through the proxy", async () => {
    // Given
    const proxyUrl = "http://127.0.0.1:4321/media"
    const close = vi.fn()
    mocks.openSeekableMediaProxy.mockResolvedValue({ url: proxyUrl, close })
    mocks.spawn.mockReturnValue(fakeChild())

    // When
    const resource = await new DiscordAudioResourceFactory().create(
      remoteMedia,
      0,
      undefined,
      bufferedAfterMs,
    )

    // Then
    expect(mocks.openSeekableMediaProxy).toHaveBeenCalledOnce()
    expect(mocks.openDirectStream).not.toHaveBeenCalled()
    const args = mocks.spawn.mock.calls[0]?.[1] as readonly string[]
    expect(args).toContain(proxyUrl)
    expect(args).not.toContain("pipe:0")
    resource.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it("Given a short webm-opus track When a resource is created Then it passes straight through", async () => {
    // Given
    const stream = new PassThrough()
    mocks.bufferDirectStream.mockResolvedValue(stream)

    // When
    const resource = await new DiscordAudioResourceFactory().create(
      remoteMedia,
      0,
      undefined,
      bufferedAfterMs - 1,
    )

    // Then
    expect(mocks.openSeekableMediaProxy).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.openDirectStream).toHaveBeenCalledOnce()
    resource.dispose()
    expect(stream.destroyed).toBe(true)
  })

  it("Given a short non-opus track When a resource is created Then ffmpeg is fed the direct stream", async () => {
    // Given
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)

    // When
    const resource = await new DiscordAudioResourceFactory().create(
      { ...remoteMedia, container: "m4a", codec: "aac" },
      0,
      undefined,
      60_000,
    )

    // Then
    expect(mocks.openSeekableMediaProxy).not.toHaveBeenCalled()
    expect(mocks.openDirectStream).toHaveBeenCalledOnce()
    const args = mocks.spawn.mock.calls[0]?.[1] as readonly string[]
    expect(args).toContain("pipe:0")
    resource.dispose()
  })

  it("Given a local track When a resource is created Then ffmpeg reads the file without a proxy", async () => {
    // Given
    mocks.spawn.mockReturnValue(fakeChild())

    // When
    const resource = await new DiscordAudioResourceFactory().create(localMedia, 0)

    // Then
    expect(mocks.openSeekableMediaProxy).not.toHaveBeenCalled()
    expect(mocks.openDirectStream).not.toHaveBeenCalled()
    const args = mocks.spawn.mock.calls[0]?.[1] as readonly string[]
    expect(args).toContain(localMedia.url)
    resource.dispose()
  })
})
