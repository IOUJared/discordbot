import {
  MEDIA_SIDECAR_OBSERVATION_SCHEMA,
  type SidecarRuntimeObservationSink,
} from "./youtube-sidecar-observation.js"

type PendingSearch<Result> = {
  readonly key: string
  readonly controller: AbortController
  readonly outcome: Promise<Result>
  readonly isSettled: () => boolean
  waiters: number
}

type CoalescedSearchRequest<Result> = {
  readonly key: string
  readonly correlationId: string
  readonly signal?: AbortSignal
  readonly start: (signal: AbortSignal) => Promise<Result>
}

export class YouTubeSearchCoalescer<Result> {
  private readonly pending = new Map<string, PendingSearch<Result>>()

  constructor(private readonly observe: SidecarRuntimeObservationSink) {}

  run(request: CoalescedSearchRequest<Result>): Promise<Result> {
    const existing = this.pending.get(request.key)
    const pending = existing ?? this.start(request.key, request.start)
    return this.wait(pending, request)
  }

  private start(
    key: string,
    start: (signal: AbortSignal) => Promise<Result>,
  ): PendingSearch<Result> {
    const controller = new AbortController()
    let settled = false
    let pending: PendingSearch<Result> | undefined
    const outcome = start(controller.signal).finally(() => {
      settled = true
      if (pending !== undefined && this.pending.get(key) === pending) this.pending.delete(key)
    })
    pending = { key, controller, outcome, isSettled: () => settled, waiters: 0 }
    this.pending.set(key, pending)
    return pending
  }

  private wait(
    pending: PendingSearch<Result>,
    request: CoalescedSearchRequest<Result>,
  ): Promise<Result> {
    pending.waiters += 1
    this.emit(request.correlationId, pending.waiters)
    if (request.signal === undefined) {
      return pending.outcome.finally(() => this.release(pending, request.correlationId, false))
    }
    const signal = request.signal
    return new Promise((resolve, reject) => {
      let active = true
      const release = (aborted: boolean): void => {
        if (!active) return
        active = false
        signal.removeEventListener("abort", abort)
        this.release(pending, request.correlationId, aborted)
      }
      const abort = (): void => {
        release(true)
        reject(new DOMException("The operation was aborted", "AbortError"))
      }
      signal.addEventListener("abort", abort, { once: true })
      void pending.outcome.then(
        (result) => {
          if (!active) return
          release(false)
          resolve(result)
        },
        (error: unknown) => {
          if (!active) return
          release(false)
          reject(error)
        },
      )
    })
  }

  private release(pending: PendingSearch<Result>, correlationId: string, aborted: boolean): void {
    pending.waiters -= 1
    this.emit(correlationId, pending.waiters)
    if (aborted && pending.waiters === 0 && !pending.isSettled()) {
      if (this.pending.get(pending.key) === pending) this.pending.delete(pending.key)
      pending.controller.abort()
    }
  }

  private emit(correlationId: string, waiterCount: number): void {
    this.observe({
      schema: MEDIA_SIDECAR_OBSERVATION_SCHEMA,
      stage: "waiter_count",
      correlationId,
      waiterCount,
    })
  }
}
