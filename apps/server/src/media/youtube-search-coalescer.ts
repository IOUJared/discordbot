import {
  MEDIA_SIDECAR_OBSERVATION_SCHEMA,
  registerRequestCorrelation,
  type SidecarRuntimeObservationSink,
} from "./youtube-sidecar-observation.js"

type PendingSearch<Result> = {
  readonly key: string
  readonly correlationId: string
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

type CoalescedSearch<Result> = {
  readonly correlationId: string
  readonly outcome: Promise<Result>
}

export class YouTubeSearchCoalescer<Result> {
  private readonly pending = new Map<string, PendingSearch<Result>>()

  constructor(private readonly observe: SidecarRuntimeObservationSink) {}

  run(request: CoalescedSearchRequest<Result>): CoalescedSearch<Result> {
    const existing = this.pending.get(request.key)
    const pending = existing ?? this.start(request)
    if (request.signal !== undefined) {
      registerRequestCorrelation(request.signal, pending.correlationId)
    }
    return {
      correlationId: pending.correlationId,
      outcome: this.wait(pending, request.signal),
    }
  }

  private start(request: CoalescedSearchRequest<Result>): PendingSearch<Result> {
    const controller = new AbortController()
    registerRequestCorrelation(controller.signal, request.correlationId)
    let settled = false
    let pending: PendingSearch<Result> | undefined
    const outcome = request.start(controller.signal).finally(() => {
      settled = true
      if (pending !== undefined && this.pending.get(request.key) === pending)
        this.pending.delete(request.key)
    })
    pending = {
      key: request.key,
      correlationId: request.correlationId,
      controller,
      outcome,
      isSettled: () => settled,
      waiters: 0,
    }
    this.pending.set(request.key, pending)
    return pending
  }

  private wait(pending: PendingSearch<Result>, signal: AbortSignal | undefined): Promise<Result> {
    pending.waiters += 1
    this.emit(pending.correlationId, pending.waiters)
    if (signal === undefined) {
      return pending.outcome.finally(() => this.release(pending, false))
    }
    return new Promise((resolve, reject) => {
      let active = true
      const release = (aborted: boolean): void => {
        if (!active) return
        active = false
        signal.removeEventListener("abort", abort)
        this.release(pending, aborted)
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

  private release(pending: PendingSearch<Result>, aborted: boolean): void {
    pending.waiters -= 1
    this.emit(pending.correlationId, pending.waiters)
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
