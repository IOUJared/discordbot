import {
  ChannelIdSchema,
  LoopModeSchema,
  QueueItemIdSchema,
  TrackSchema,
  VolumeSchema,
} from "@discord-music/contracts"
import { z } from "zod"

export const exchangeSchema = z.object({ code: z.string().min(1).max(1024) }).strict()
export const searchSchema = z.object({ q: z.string().trim().min(1).max(512) }).strict()
export const playlistPreviewSchema = z.object({ url: z.url().max(2048) }).strict()
export const playlistImportSchema = z
  .object({
    url: z.url().max(2048),
    channelId: ChannelIdSchema.optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
export const expectedVersionSchema = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict()
export const addSchema = z
  .object({
    track: TrackSchema,
    channelId: ChannelIdSchema.optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
export const idParamsSchema = z.object({ id: QueueItemIdSchema }).strict()
export const orderSchema = z
  .object({
    id: QueueItemIdSchema,
    index: z.number().int().nonnegative(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
export const seekSchema = z.object({ positionMs: z.number().int().nonnegative() }).strict()
export const volumeSchema = z.object({ volume: VolumeSchema }).strict()
export const loopSchema = z.object({ loopMode: LoopModeSchema }).strict()
export const joinSchema = z.object({ channelId: ChannelIdSchema }).strict()
export const oauthCallbackSchema = z
  .object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(2048) })
  .strict()
export const wsAuthSchema = z
  .object({ type: z.literal("auth"), token: z.string().min(1).max(2048) })
  .strict()
