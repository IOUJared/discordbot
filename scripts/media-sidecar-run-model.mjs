import { createHash } from "node:crypto"

export class ModelError extends Error {
  constructor(code) {
    super(code)
    this.name = "ModelError"
    this.code = code
  }
}

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export class DeploymentModel {
  constructor({ state, random = () => "0".repeat(32) }) {
    this.live = structuredClone(state)
    this.random = random
    this.counter = 0
    this.lease = undefined
    this.archives = new Map()
    this.writes = []
    this.events = []
    this.now = 1_000
  }

  preflight() {
    const writes = this.writes.length
    const result = {
      clean: true,
      fingerprint: fingerprint(this.live),
      lease: this.lease?.state ?? "absent",
      restored: this.lease?.restoreState ?? "absent",
    }
    if (this.writes.length !== writes) throw new ModelError("preflight_write")
    return result
  }

  beginRun({ sha, kind, deadline = 600, crashAt }) {
    if (
      this.lease?.state === "active" ||
      (this.lease?.state === "expired" && this.lease.restoreState !== "restored")
    )
      throw new ModelError("lease_busy")
    if (this.lease !== undefined) {
      this.archives.set(this.lease.runId, structuredClone(this.lease))
      this.writes.push("archive_terminal")
    }
    this.counter += 1
    this.writes.push("counter_fsync")
    if (crashAt === "after_counter_fsync") throw new ModelError("injected_crash")
    const suffix = this.random()
    if (!/^[0-9a-f]{32}$/u.test(suffix)) throw new ModelError("random_source")
    const runId = `${this.counter}-${suffix}`
    const checkpoint = structuredClone(this.live)
    const manifest = { hash: fingerprint(checkpoint), exact: checkpoint }
    this.writes.push("temp_checkpoint_verified")
    if (crashAt === "after_temp_verify") throw new ModelError("injected_crash")
    this.writes.push("checkpoint_renamed")
    if (crashAt === "after_checkpoint_rename") throw new ModelError("injected_crash")
    this.lease = {
      runId,
      generation: this.counter,
      sha,
      kind,
      sequence: 0,
      deadline: this.now + deadline,
      deadlineClock: "CLOCK_BOOTTIME",
      state: "active",
      restoreState: "idle",
      checkpoint,
      manifest,
      tagsVerified: false,
      accepted: [],
      stableSamples: 0,
      lateDaemonDetected: false,
    }
    this.writes.push("active_published")
    if (crashAt === "after_active_publish") throw new ModelError("injected_crash")
    return { runId, sequence: 0, generation: this.counter }
  }

  mutate({ runId, sequence, operation, apply = () => undefined }) {
    const lease = this.requireActive(runId, sequence)
    lease.sequence += 1
    lease.accepted.push({ sequence: lease.sequence, operation, terminal: false })
    this.writes.push(`accepted:${operation}`)
    apply(this.live)
    lease.accepted.at(-1).terminal = true
    if (operation === "tag-prior") lease.tagsVerified = true
    return { sequence: lease.sequence }
  }

  expire({ runId, delayedDaemon }) {
    const lease = this.lease
    if (lease?.runId !== runId || lease.state !== "active") throw new ModelError("lease_fenced")
    lease.state = "expired"
    lease.restoreState = "fencing"
    this.writes.push("expired")
    lease.restoreState = "restoring"
    this.live = structuredClone(lease.checkpoint)
    this.events.push("restore_apply_1")
    lease.stableSamples = 1
    delayedDaemon?.(this.live)
    if (fingerprint(this.live) !== lease.manifest.hash) {
      this.events.push("late_daemon_detected")
      lease.lateDaemonDetected = true
      this.live = structuredClone(lease.checkpoint)
      this.events.push("restore_apply_2")
      lease.stableSamples = 0
    }
    lease.stableSamples += 1
    this.now += 5
    if (fingerprint(this.live) !== lease.manifest.hash) throw new ModelError("restore_drift")
    lease.stableSamples += 1
    lease.restoreState = "restored"
    this.writes.push("restored")
    return {
      state: lease.state,
      restoreState: lease.restoreState,
      stableSamples: 2,
      lateDaemonDetected: lease.lateDaemonDetected,
    }
  }

  commit({ runId, sequence }) {
    const lease = this.requireActive(runId, sequence)
    if (!lease.tagsVerified) throw new ModelError("rollback_tags_missing")
    lease.sequence += 1
    lease.state = "committed"
    this.writes.push("committed")
    return { sequence: lease.sequence, state: lease.state }
  }

  cleanup({ retainAfterGeneration }) {
    for (const [runId, lease] of this.archives) {
      const terminal =
        lease.state === "committed" ||
        (lease.state === "expired" && lease.restoreState === "restored")
      if (terminal && lease.generation < retainAfterGeneration) this.archives.delete(runId)
    }
  }

  requireActive(runId, sequence) {
    const lease = this.lease
    if (lease?.runId !== runId) throw new ModelError("wrong_run")
    if (lease.state !== "active") throw new ModelError("terminal_lease")
    if (lease.sequence !== sequence) throw new ModelError("stale_sequence")
    if (this.now >= lease.deadline) throw new ModelError("deadline")
    return lease
  }
}

export function validateObservation(event) {
  const allowed = new Set([
    "schema",
    "stage",
    "operation",
    "correlationId",
    "outcome",
    "mode",
    "state",
    "pendingShadow",
    "fingerprint",
    "count",
    "waiterCount",
  ])
  if (event.schema !== "media_sidecar_observation.v1") throw new ModelError("observation_schema")
  if (Object.keys(event).some((key) => !allowed.has(key))) throw new ModelError("observation_field")
  const serialized = JSON.stringify(event)
  if (/youtube\.com|watch\?v=|query|salt|authorization|cookie/iu.test(serialized))
    throw new ModelError("observation_secret")
  return true
}
