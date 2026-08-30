import { z } from "zod"

export const TRACK_PROVIDERS = ["youtube", "spotify", "soundcloud", "url", "mock_tidal"] as const
export const LOOP_MODES = ["off", "track", "queue"] as const
export const MEDIA_SOURCE_PREFERENCES = ["mock_tidal_first", "youtube_only"] as const
export const HISTORY_END_REASONS = ["finished", "skipped", "stopped", "errored"] as const

const boundedIdentifier = z.string().trim().min(1).max(256)
const timestamp = z.iso.datetime({ offset: true })

export const TrackIdSchema = boundedIdentifier.brand<"TrackId">()
export const QueueItemIdSchema = boundedIdentifier.brand<"QueueItemId">()
export const UserIdSchema = boundedIdentifier.brand<"UserId">()
export const GuildIdSchema = boundedIdentifier.brand<"GuildId">()
export const ChannelIdSchema = boundedIdentifier.brand<"ChannelId">()
export const HistoryItemIdSchema = boundedIdentifier.brand<"HistoryItemId">()
export const DurationMsSchema = z.number().int().nonnegative().brand<"DurationMs">()
export const PositionMsSchema = z.number().int().nonnegative().brand<"PositionMs">()
export const VolumeSchema = z.number().int().min(0).max(200).brand<"Volume">()
export const TimestampSchema = timestamp.brand<"Timestamp">()

export type TrackId = z.infer<typeof TrackIdSchema>
export type QueueItemId = z.infer<typeof QueueItemIdSchema>
export type UserId = z.infer<typeof UserIdSchema>
export type GuildId = z.infer<typeof GuildIdSchema>
export type ChannelId = z.infer<typeof ChannelIdSchema>
export type HistoryItemId = z.infer<typeof HistoryItemIdSchema>
export type DurationMs = z.infer<typeof DurationMsSchema>
export type PositionMs = z.infer<typeof PositionMsSchema>
export type Volume = z.infer<typeof VolumeSchema>
export type Timestamp = z.infer<typeof TimestampSchema>

export const TrackProviderSchema = z.enum(TRACK_PROVIDERS)
export const LoopModeSchema = z.enum(LOOP_MODES)
export const MediaSourcePreferenceSchema = z.enum(MEDIA_SOURCE_PREFERENCES)
export const HistoryEndReasonSchema = z.enum(HISTORY_END_REASONS)

export type TrackProvider = z.infer<typeof TrackProviderSchema>
export type LoopMode = z.infer<typeof LoopModeSchema>
export type MediaSourcePreference = z.infer<typeof MediaSourcePreferenceSchema>
export type HistoryEndReason = z.infer<typeof HistoryEndReasonSchema>

export const TrackSchema = z
  .object({
    id: TrackIdSchema,
    provider: TrackProviderSchema,
    title: z.string().trim().min(1).max(512),
    artist: z.string().trim().min(1).max(512),
    url: z.string().url(),
    durationMs: DurationMsSchema,
    artworkUrl: z.string().url().optional(),
  })
  .strict()

export type Track = Readonly<z.infer<typeof TrackSchema>>

export const QueueItemSchema = z
  .object({
    id: QueueItemIdSchema,
    track: TrackSchema,
    requestedBy: UserIdSchema,
    addedAt: TimestampSchema,
  })
  .strict()

export type QueueItem = Readonly<z.infer<typeof QueueItemSchema>>

export const SearchResultSchema = z
  .object({
    track: TrackSchema,
    score: z.number().min(0).max(1),
  })
  .strict()

export type SearchResult = Readonly<z.infer<typeof SearchResultSchema>>

export const MediaProviderSettingsSchema = z
  .object({
    preference: MediaSourcePreferenceSchema,
    mockTidalConnected: z.boolean(),
  })
  .strict()

export type MediaProviderSettings = Readonly<z.infer<typeof MediaProviderSettingsSchema>>

export const PlayerSnapshotSchema = z
  .object({
    guildId: GuildIdSchema,
    queue: z.array(QueueItemSchema).readonly(),
    currentItem: QueueItemSchema.nullable(),
    positionMs: PositionMsSchema,
    volume: VolumeSchema,
    isPaused: z.boolean(),
    loopMode: LoopModeSchema,
  })
  .strict()

export type PlayerSnapshot = Readonly<z.infer<typeof PlayerSnapshotSchema>>

export const VoiceStatusSchema = z
  .object({
    guildId: GuildIdSchema,
    connected: z.boolean(),
    channelId: ChannelIdSchema.nullable(),
    muted: z.boolean(),
    deafened: z.boolean(),
  })
  .strict()

export type VoiceStatus = Readonly<z.infer<typeof VoiceStatusSchema>>

export const HistoryItemSchema = z
  .object({
    id: HistoryItemIdSchema,
    queueItem: QueueItemSchema,
    playedAt: TimestampSchema,
    endedAt: TimestampSchema.nullable(),
    endReason: HistoryEndReasonSchema.nullable(),
  })
  .strict()

export type HistoryItem = Readonly<z.infer<typeof HistoryItemSchema>>

export const SearchTracksRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    provider: TrackProviderSchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()

export const EnqueueTrackRequestSchema = z
  .object({
    track: TrackSchema,
    requestedBy: UserIdSchema,
  })
  .strict()

export const SetVolumeRequestSchema = z.object({ volume: VolumeSchema }).strict()
export const SetLoopModeRequestSchema = z.object({ loopMode: LoopModeSchema }).strict()
export const JoinVoiceRequestSchema = z
  .object({
    guildId: GuildIdSchema,
    channelId: ChannelIdSchema,
  })
  .strict()

export type SearchTracksRequest = Readonly<z.infer<typeof SearchTracksRequestSchema>>
export type EnqueueTrackRequest = Readonly<z.infer<typeof EnqueueTrackRequestSchema>>
export type SetVolumeRequest = Readonly<z.infer<typeof SetVolumeRequestSchema>>
export type SetLoopModeRequest = Readonly<z.infer<typeof SetLoopModeRequestSchema>>
export type JoinVoiceRequest = Readonly<z.infer<typeof JoinVoiceRequestSchema>>

export const PlayerSnapshotMessageSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("player.snapshot"),
    payload: PlayerSnapshotSchema,
  })
  .strict()

export const QueueUpdatedMessageSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("queue.updated"),
    payload: z
      .object({
        guildId: GuildIdSchema,
        queue: z.array(QueueItemSchema).readonly(),
      })
      .strict(),
  })
  .strict()

export const PlaybackProgressMessageSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("playback.progress"),
    payload: z.object({ guildId: GuildIdSchema, positionMs: PositionMsSchema }).strict(),
  })
  .strict()

export const VoiceStatusMessageSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("voice.status"),
    payload: VoiceStatusSchema,
  })
  .strict()

export const WebSocketMessageSchema = z.discriminatedUnion("type", [
  PlayerSnapshotMessageSchema,
  QueueUpdatedMessageSchema,
  PlaybackProgressMessageSchema,
  VoiceStatusMessageSchema,
])

export type PlayerSnapshotMessage = Readonly<z.infer<typeof PlayerSnapshotMessageSchema>>
export type QueueUpdatedMessage = Readonly<z.infer<typeof QueueUpdatedMessageSchema>>
export type PlaybackProgressMessage = Readonly<z.infer<typeof PlaybackProgressMessageSchema>>
export type VoiceStatusMessage = Readonly<z.infer<typeof VoiceStatusMessageSchema>>
export type WebSocketMessage = Readonly<z.infer<typeof WebSocketMessageSchema>>

export const ApiErrorSchema = z
  .object({
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
  })
  .strict()

export const PlayerStateSchema = z
  .object({
    version: z.number().int().nonnegative(),
    player: PlayerSnapshotSchema,
    voice: VoiceStatusSchema,
    providers: MediaProviderSettingsSchema,
  })
  .strict()

export const PlayerStateMessageSchema = z
  .object({ version: z.literal(1), type: z.literal("state.snapshot"), payload: PlayerStateSchema })
  .strict()

export type PlayerState = Readonly<z.infer<typeof PlayerStateSchema>>
export type PlayerStateMessage = Readonly<z.infer<typeof PlayerStateMessageSchema>>
