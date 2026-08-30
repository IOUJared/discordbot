export type PositionSample = {
  readonly positionMs: number
  readonly durationMs: number
  readonly paused: boolean
  readonly observedAtMs: number
}

export function interpolatePosition(sample: PositionSample, nowMs: number): number {
  if (sample.paused) return sample.positionMs
  return Math.min(sample.durationMs, sample.positionMs + Math.max(0, nowMs - sample.observedAtMs))
}

export function nextReconnectDelay(attempt: number, random: () => number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.75 + random() * 0.5))
}
