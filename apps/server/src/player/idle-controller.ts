import type { PlayerScheduler } from "./ports.js"

const idleTimeoutMs = 5 * 60_000

export class IdleController {
  private cancelTimer: (() => void) | null = null

  constructor(
    private readonly scheduler: PlayerScheduler,
    private readonly onIdle: () => void,
  ) {}

  schedule(): void {
    this.cancel()
    this.cancelTimer = this.scheduler.schedule(this.onIdle, idleTimeoutMs)
  }

  cancel(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }
}
