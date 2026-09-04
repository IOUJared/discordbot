import { DeploymentModel } from "./media-sidecar-run-model.mjs"

export const priorPresent = {
  config: "services: server+sidecar\n",
  env: "MEDIA_SIDECAR_MODE=rust\nSECRET=protected\n",
  git: "a".repeat(40),
  mode: "rust",
  sidecarPresent: true,
  serverImage: "sha256:server-old",
  sidecarImage: "sha256:sidecar-old",
  publicHealth: { status: "ok", discord: "ready", voice: "idle", uptime: 9 },
  volumes: ["db-volume"],
}

export const priorAbsent = { ...priorPresent, mode: "disabled", sidecarPresent: false }

export function model(state = priorPresent) {
  let suffix = 0
  return new DeploymentModel({
    state,
    random: () => {
      suffix += 1
      return `${suffix}`.padStart(32, "0")
    },
  })
}

export function active(instance, kind = "deploy") {
  const run = instance.beginRun({ sha: "b".repeat(40), kind })
  const tagged = instance.mutate({ ...run, operation: "tag-prior" })
  return { ...run, sequence: tagged.sequence }
}
