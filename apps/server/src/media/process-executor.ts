import { execFile } from "node:child_process"

import type { ProcessExecutor, ProcessOutput, ProcessRequest } from "./types.js"

export class ExternalProcessError extends Error {
  readonly file: string
  readonly stderr: string

  constructor(file: string, stderr: string, cause: Error) {
    super(`External process failed: ${file}`, { cause })
    this.name = "ExternalProcessError"
    this.file = file
    this.stderr = stderr
  }
}

export const nodeProcessExecutor: ProcessExecutor = {
  run: (request: ProcessRequest) =>
    new Promise<ProcessOutput>((resolve, reject) => {
      execFile(
        request.file,
        [...request.args],
        {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
          shell: false,
          signal: request.signal,
          timeout: request.timeoutMs,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new ExternalProcessError(request.file, stderr, error))
            return
          }
          resolve({ stdout, stderr })
        },
      )
    }),
}
