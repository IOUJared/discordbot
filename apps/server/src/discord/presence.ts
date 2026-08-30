import type { PlayerSnapshot } from "@discord-music/contracts"
import { ActivityType, type PresenceData } from "discord.js"

export function presenceFor(snapshot: PlayerSnapshot): PresenceData {
  const current = snapshot.currentItem
  if (current === null) return { status: "idle", activities: [] }
  return {
    status: snapshot.isPaused ? "idle" : "online",
    activities: [{ name: current.track.title, type: ActivityType.Listening }],
  }
}
