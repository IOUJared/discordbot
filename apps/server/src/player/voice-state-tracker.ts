import type { ChannelId } from "@discord-music/contracts"

import type { VoiceGateway, VoiceStateEvent } from "./ports.js"

export class VoiceStateTracker {
  channelId: ChannelId | null = null

  constructor(voice: VoiceGateway, onChange: () => void) {
    voice.onStatus((event) => {
      this.apply(event)
      onChange()
    })
  }

  private apply(event: VoiceStateEvent): void {
    switch (event.kind) {
      case "connected":
        this.channelId = event.channelId
        break
      case "disconnected":
        this.channelId = null
        break
      default:
        assertNever(event)
    }
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported voice state: ${String(value)}`)
}
