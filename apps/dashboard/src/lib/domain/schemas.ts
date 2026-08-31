import { z } from "zod/mini"

const identifier = z.string().check(z.trim(), z.minLength(1), z.maxLength(256))
const trackId = identifier.brand<"TrackId">()
const queueItemId = identifier.brand<"QueueItemId">()
const userId = identifier.brand<"UserId">()
const guildId = identifier.brand<"GuildId">()
const channelId = identifier.brand<"ChannelId">()
const historyItemId = identifier.brand<"HistoryItemId">()
const timestamp = z.iso.datetime({ offset: true }).brand<"Timestamp">()
const duration = z.int().check(z.nonnegative()).brand<"DurationMs">()
const position = z.int().check(z.nonnegative()).brand<"PositionMs">()
const volume = z.int().check(z.minimum(0), z.maximum(200)).brand<"Volume">()
const bitrateKbps = z.int().check(z.positive(), z.maximum(100_000)).brand<"BitrateKbps">()

export const SessionSchema = z.strictObject({
  token: z.string().check(z.minLength(1)),
  expiresAt: z.iso.datetime(),
})

export const TrackSchema = z.strictObject({
  id: trackId,
  provider: z.literal("youtube"),
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  artist: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  url: z.url(),
  durationMs: duration,
  artworkUrl: z.optional(z.url()),
})

export const QueueItemSchema = z.strictObject({
  id: queueItemId,
  track: TrackSchema,
  requestedBy: userId,
  addedAt: timestamp,
})

export const SearchResultSchema = z.strictObject({
  track: TrackSchema,
  score: z.number().check(z.minimum(0), z.maximum(1)),
  bitrateKbps: z.nullable(bitrateKbps),
})

const playerSchema = z.strictObject({
  guildId,
  queue: z.readonly(z.array(QueueItemSchema)),
  currentItem: z.nullable(QueueItemSchema),
  bitrateKbps: z.optional(z.nullable(bitrateKbps)),
  seekable: z.boolean(),
  positionMs: position,
  volume,
  isPaused: z.boolean(),
  loopMode: z.enum(["off", "track", "queue"]),
})

const voiceSchema = z.strictObject({
  guildId,
  connected: z.boolean(),
  channelId: z.nullable(channelId),
  muted: z.boolean(),
  deafened: z.boolean(),
})

export const PlayerStateSchema = z.strictObject({
  version: z.int().check(z.nonnegative()),
  player: playerSchema,
  voice: voiceSchema,
})
export const PlaylistImportResultSchema = z.strictObject({
  state: PlayerStateSchema,
  importedCount: z.int().check(z.positive(), z.maximum(500)),
})

export const PlayerStateMessageSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("state.snapshot"),
  payload: PlayerStateSchema,
})

export const PlaybackFailureMessageSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("playback.failed"),
  payload: z.strictObject({
    guildId,
    queueItemId,
    trackId,
    provider: z.literal("youtube"),
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    artist: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    message: z.literal("Playback failed; skipped to the next track."),
  }),
})

const VoiceChannelSchema = z.strictObject({
  id: identifier,
  name: identifier,
  memberCount: z.int().check(z.nonnegative()),
})

export const VoiceChannelsMessageSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("voice.channels"),
  payload: z.strictObject({ channels: z.readonly(z.array(VoiceChannelSchema)) }),
})

export const SocketMessageSchema = z.discriminatedUnion("type", [
  PlayerStateMessageSchema,
  PlaybackFailureMessageSchema,
  VoiceChannelsMessageSchema,
])

export const HistoryItemSchema = z.strictObject({
  id: historyItemId,
  queueItem: QueueItemSchema,
  playedAt: timestamp,
  endedAt: z.nullable(timestamp),
  endReason: z.nullable(z.enum(["finished", "skipped", "stopped", "errored"])),
})

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().check(z.minLength(1)),
    message: z.string().check(z.minLength(1)),
  }),
})

export const ChannelsSchema = z.strictObject({
  channels: z.readonly(z.array(VoiceChannelSchema)),
})

export const ResultsSchema = z.strictObject({ results: z.readonly(z.array(SearchResultSchema)) })
export const YouTubePlaylistSchema = z.strictObject({
  id: identifier,
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  author: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  artworkUrl: z.optional(z.url()),
  tracks: z.readonly(z.array(TrackSchema).check(z.minLength(1), z.maxLength(500))),
})
export const HistorySchema = z.strictObject({ items: z.readonly(z.array(HistoryItemSchema)) })
