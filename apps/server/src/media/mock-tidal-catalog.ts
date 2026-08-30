import { DurationMsSchema, type SearchResult, TrackSchema } from "@discord-music/contracts"

type CatalogTrack = {
  readonly slug: string
  readonly title: string
  readonly artist: string
  readonly durationSeconds: number
  readonly frequencyHz: number
}

export const mockTidalCatalog = [
  {
    slug: "midnight-circuit",
    title: "Midnight Circuit",
    artist: "The Classroom Sessions",
    durationSeconds: 12,
    frequencyHz: 220,
  },
  {
    slug: "glass-horizon",
    title: "Glass Horizon",
    artist: "The Classroom Sessions",
    durationSeconds: 12,
    frequencyHz: 261.63,
  },
  {
    slug: "indigo-static",
    title: "Indigo Static",
    artist: "The Classroom Sessions",
    durationSeconds: 12,
    frequencyHz: 329.63,
  },
] as const satisfies readonly CatalogTrack[]

export function searchMockTidalCatalog(query: string): readonly SearchResult[] {
  const words = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
  if (words.length === 0) return []
  return mockTidalCatalog.flatMap((entry) => {
    const haystack = `${entry.title} ${entry.artist}`.toLocaleLowerCase()
    if (!words.every((word) => haystack.includes(word))) return []
    return [
      {
        track: TrackSchema.parse({
          id: `mock-tidal:${entry.slug}`,
          provider: "mock_tidal",
          title: entry.title,
          artist: entry.artist,
          url: `https://mock.tidal.invalid/tracks/${entry.slug}`,
          durationMs: DurationMsSchema.parse(entry.durationSeconds * 1_000),
        }),
        score: 1,
      },
    ]
  })
}

export function mockTidalCatalogEntry(trackId: string): CatalogTrack | undefined {
  return mockTidalCatalog.find((entry) => `mock-tidal:${entry.slug}` === trackId)
}
