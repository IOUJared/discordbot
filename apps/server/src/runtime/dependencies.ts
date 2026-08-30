import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)

export type DependencyStatus = {
  readonly ffmpeg: boolean
  readonly ytDlp: boolean
}

export class MissingDependencyError extends Error {
  readonly name = "MissingDependencyError"

  constructor(readonly commands: readonly string[]) {
    super(`Missing required media commands: ${commands.join(", ")}`)
  }
}

export function assertDependencies(status: DependencyStatus): void {
  const missing = [...(status.ffmpeg ? [] : ["ffmpeg"]), ...(status.ytDlp ? [] : ["yt-dlp"])]
  if (missing.length > 0) throw new MissingDependencyError(missing)
}

export async function checkDependencies(
  run: (file: string, args: readonly string[]) => Promise<void> = runVersion,
): Promise<DependencyStatus> {
  const [ffmpeg, ytDlp] = await Promise.all([
    available(run, "ffmpeg", ["-version"]),
    available(run, "yt-dlp", ["--version"]),
  ])
  return { ffmpeg, ytDlp }
}

async function available(
  run: (file: string, args: readonly string[]) => Promise<void>,
  file: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await run(file, args)
    return true
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

async function runVersion(file: string, args: readonly string[]): Promise<void> {
  await execute(file, args, { timeout: 5_000 })
}
