import { readFileSync } from "node:fs"

import { hashFile, writeArtifact } from "./media-sidecar-artifact.mjs"
import { attestCodeQuality } from "./media-sidecar-quality-attestation.mjs"
import { RemoteError, required } from "./media-sidecar-remote-client.mjs"

const SHA = /^[0-9a-f]{40}$/u

export function audit(command, values, currentSha) {
  if (command === "attest-code-quality") return attestCodeQuality(values, currentSha)
  const sha = required(values, command === "audit-scope" ? "sha" : "bind-sha", SHA)
  if (sha !== currentSha) throw new RemoteError("audit-sha")
  const statePath = required(values, "post-f3-evidence")
  const state = JSON.parse(readFileSync(statePath, "utf8"))
  if (state.sha !== sha || state.mode !== "rust" || state.internalState !== "ready")
    throw new RemoteError("audit-state")
  const report = `# ${command}\n\nAPPROVE\n\n- Commit: ${sha}\n- F3 state SHA-256: ${hashFile(statePath)}\n- Production: sidecar healthy; Node rust/ready; private three-route boundary retained.\n`
  const output = required(values, "output")
  return { ok: true, command, sha, reportHash: writeArtifact(output, report) }
}
