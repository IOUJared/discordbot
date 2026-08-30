export function validateSeekOffset(offsetMs: number, durationMs: number): void {
  if (!Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs >= durationMs) {
    throw new RangeError("Seek offset is outside the track")
  }
}
