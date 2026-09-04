import { type SearchResult, TrackSchema } from "@discord-music/contracts"

export const fixture = JSON.stringify({
  entries: [
    {
      id: "video-1",
      title: "Song",
      uploader: "Artist",
      webpage_url: "https://www.youtube.com/watch?v=video-1",
      duration: 42,
      thumbnail: "https://img.youtube.com/video-1.jpg",
    },
  ],
})

export const searchResults = [
  {
    track: TrackSchema.parse({
      id: "video-1",
      provider: "youtube",
      title: "Song",
      artist: "Artist",
      url: "https://www.youtube.com/watch?v=video-1",
      durationMs: 42_000,
      artworkUrl: "https://img.youtube.com/video-1.jpg",
    }),
    score: 1,
    bitrateKbps: null,
  },
] satisfies readonly SearchResult[]
