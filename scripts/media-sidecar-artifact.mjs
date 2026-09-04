import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

export function writeArtifact(path, value) {
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const content = `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`
  writeFileSync(target, content, { mode: 0o600 })
  return createHash("sha256").update(readFileSync(target)).digest("hex")
}

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}
