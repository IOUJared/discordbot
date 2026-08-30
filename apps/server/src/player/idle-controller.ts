import type { PlayerScheduler } from "./ports.js"

export class IdleController {
  private cancelTimer: (() => void) | null = null

  constructor(
    private readonly scheduler: PlayerScheduler,
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
  ) {}

  schedule(): void {
    this.cancel()
    this.cancelTimer = this.scheduler.schedule(this.onIdle, this.timeoutMs)
  }

  cancel(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }
}
