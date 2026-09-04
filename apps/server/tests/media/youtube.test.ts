import { describe, expect, it } from "vitest"

import {
  parsePlaylistOutput,
  YouTubeMusicSource,
  youtubePlaylistArgs,
} from "../../src/media/youtube.js"
import { parseRadioSearchOutput, youtubeRadioSearchArgs } from "../../src/media/youtube-radio.js"
import { fixture } from "./youtube.test-helpers.js"

describe("YouTube radio and playlist boundary", () => {
  it("Given a radio genre When playlist discovery arguments are built Then YouTube playlist results are requested safely", () => {
    // Given
    const genre = "indie rock; $(id)"

    // When
    const args = youtubeRadioSearchArgs(genre)

    // Then
    expect(args.at(0)).toBe("--ignore-config")
    expect(args.at(-1)).toContain("search_query=indie+rock%3B+%24%28id%29+music+playlist")
    expect(args.at(-1)).toContain("sp=EgIQAw%253D%253D")
    expect(args).toContain("--flat-playlist")
  })

  it("Given playlist-filtered YouTube results When discovery output is parsed Then only valid playlist URLs remain", () => {
    // Given
    const output = JSON.stringify({
      entries: [
        {
          id: "PL-first",
          title: "Indie essentials",
          uploader: "Curator",
          url: "https://www.youtube.com/playlist?list=PL-first",
        },
        {
          id: "video",
          title: "Not a playlist",
          uploader: "Channel",
          url: "https://www.youtube.com/watch?v=video",
        },
      ],
    })

    // When
    const candidates = parseRadioSearchOutput(output)

    // Then
    expect(candidates).toEqual([
      {
        id: "PL-first",
        title: "Indie essentials",
        author: "Curator",
        url: "https://www.youtube.com/playlist?list=PL-first",
      },
    ])
  })

  it("Given radio playlist candidates When the first is too short Then a 50-100 track candidate is selected", async () => {
    // Given
    const discovery = JSON.stringify({
      entries: [
        {
          id: "PL-short",
          title: "Short mix",
          uploader: "Curator A",
          url: "https://www.youtube.com/playlist?list=PL-short",
        },
        {
          id: "PL-radio",
          title: "Indie radio",
          uploader: "Curator B",
          url: "https://www.youtube.com/playlist?list=PL-radio",
        },
      ],
    })
    const playlist = (id: string, count: number) =>
      JSON.stringify({
        id,
        title: id === "PL-radio" ? "Indie radio" : "Short mix",
        uploader: "Curator",
        entries: Array.from({ length: count }, (_, index) => ({
          id: `${id}-${index}`,
          title: `Song ${index + 1}`,
          uploader: `Artist ${index + 1}`,
          duration: 180,
        })),
      })
    const outputs = [discovery, playlist("PL-short", 40), playlist("PL-radio", 75)]
    const source = new YouTubeMusicSource({
      async run() {
        const stdout = outputs.shift()
        if (stdout === undefined) throw new RangeError("Unexpected radio process execution")
        return { stdout, stderr: "" }
      },
    })

    // When
    const selected = await source.radio("indie rock")

    // Then
    expect(selected).toMatchObject({ id: "PL-radio", title: "Indie radio" })
    expect(selected.tracks).toHaveLength(75)
    expect(outputs).toEqual([])
  })

  it("Given a YouTube playlist When yt-dlp metadata is parsed Then every video stays in playlist order", () => {
    // Given
    const output = JSON.stringify({
      id: "PL-list",
      title: "Road trip",
      uploader: "Jared",
      thumbnail: null,
      entries: [
        { id: "first", title: "First song", uploader: "Artist A", duration: 61, thumbnail: null },
        { id: "second", title: "Second song", uploader: "Artist B", duration: 122 },
      ],
    })

    // When
    const playlist = parsePlaylistOutput(output)

    // Then
    expect(playlist).toMatchObject({
      id: "PL-list",
      title: "Road trip",
      author: "Jared",
      tracks: [
        { id: "first", title: "First song", durationMs: 61_000 },
        { id: "second", title: "Second song", durationMs: 122_000 },
      ],
    })
  })

  it("Given a playlist URL When process arguments are built Then only YouTube playlist extraction is enabled", () => {
    // Given
    const url = "https://www.youtube.com/playlist?list=PL-list"

    // When
    const args = youtubePlaylistArgs(url)

    // Then
    expect(args.at(0)).toBe("--ignore-config")
    expect(args).toContain("--yes-playlist")
    expect(args.at(-1)).toBe(url)
  })

  it("Given a non-YouTube URL When playlist metadata is requested Then it is rejected before process execution", async () => {
    // Given
    let executions = 0
    const source = new YouTubeMusicSource({
      async run() {
        executions += 1
        return { stdout: fixture, stderr: "" }
      },
    })

    // When
    const request = source.playlist("https://example.com/playlist?id=secret")

    // Then
    await expect(request).rejects.toThrow("YouTube playlist")
    expect(executions).toBe(0)
  })

  it("Given a playlist preview When the same playlist is imported Then metadata is reused", async () => {
    // Given
    let executions = 0
    const output = JSON.stringify({
      id: "PL-list",
      title: "Road trip",
      uploader: "Jared",
      entries: [{ id: "first", title: "First song", uploader: "Artist", duration: 61 }],
    })
    const source = new YouTubeMusicSource({
      async run() {
        executions += 1
        return { stdout: output, stderr: "" }
      },
    })
    const url = "https://www.youtube.com/playlist?list=PL-list"

    // When
    await source.playlist(url)
    await source.playlist(url)

    // Then
    expect(executions).toBe(1)
  })
})
