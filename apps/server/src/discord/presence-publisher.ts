import type { PlayerSnapshot } from "@discord-music/contracts"
import { type Client, Events, type PresenceData } from "discord.js"

import { presenceFor } from "./presence.js"

export interface SnapshotSource {
  snapshot(): PlayerSnapshot
  onStateChange(listener: () => void): () => void
}

export interface PresenceClient {
  onReady(listener: () => void): void
  setPresence(presence: PresenceData): void
}

export class PresencePublishError extends Error {
  constructor() {
    super("Discord presence update failed")
    this.name = "PresencePublishError"
  }
}

export function wirePresence(
  client: PresenceClient,
  source: SnapshotSource,
  onError: (error: PresencePublishError) => void = () => undefined,
): () => void {
  const publish = () => {
    try {
      client.setPresence(presenceFor(source.snapshot()))
    } catch (error) {
      if (!(error instanceof Error)) throw error
      onError(new PresencePublishError())
    }
  }
  client.onReady(publish)
  return source.onStateChange(publish)
}

export function wireDiscordPresence(
  client: Client,
  source: SnapshotSource,
  onError?: (error: PresencePublishError) => void,
): () => void {
  const port: PresenceClient = {
    onReady: (listener) => {
      client.once(Events.ClientReady, listener)
    },
    setPresence: (presence) => {
      const user = client.user
      if (user === null) throw new PresencePublishError()
      user.setPresence(presence)
    },
  }
  return onError === undefined ? wirePresence(port, source) : wirePresence(port, source, onError)
}
