import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  openSeekableMediaProxy: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }))
vi.mock("../../src/discord/direct-stream.js", () => ({
  openSeekableMediaProxy: mocks.openSeekableMediaProxy,
}))

const { DiscordAudioResourceFactory } = await import("../../src/discord/resource-factory.js")

import { BitrateKbpsSchema } from "@discord-music/contracts"
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
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    exitCode: null as number | null,
    kill: vi.fn(),
  })
  return child
}

describe("audio resource factory", () => {
  beforeEach(() => {
    mocks.openSeekableMediaProxy.mockReset()
    mocks.spawn.mockReset()
  })

  it("Given a remote track When a resource is created Then ffmpeg reads it through the local proxy", async () => {
    // Given
    const proxyUrl = "http://127.0.0.1:4321/media"
    const close = vi.fn()
    mocks.openSeekableMediaProxy.mockResolvedValue({ url: proxyUrl, close })
    mocks.spawn.mockReturnValue(fakeChild())

    // When
    const resource = await new DiscordAudioResourceFactory().create(remoteMedia, 0)

    // Then
    expect(mocks.openSeekableMediaProxy).toHaveBeenCalledOnce()
    const args = mocks.spawn.mock.calls[0]?.[1] as readonly string[]
    expect(args).toContain(proxyUrl)
    expect(args).not.toContain("pipe:0")
    resource.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it("Given a local track When a resource is created Then ffmpeg reads the file without a proxy", async () => {
    // Given
    mocks.spawn.mockReturnValue(fakeChild())

    // When
    const resource = await new DiscordAudioResourceFactory().create(localMedia, 0)

    // Then
    expect(mocks.openSeekableMediaProxy).not.toHaveBeenCalled()
    const args = mocks.spawn.mock.calls[0]?.[1] as readonly string[]
    expect(args).toContain(localMedia.url)
    resource.dispose()
  })
})
