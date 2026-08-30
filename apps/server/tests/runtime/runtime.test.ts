import { describe, expect, it } from "vitest"

import {
  assertDependencies,
  checkDependencies,
  MissingDependencyError,
} from "../../src/runtime/dependencies.js"
import { createShutdown } from "../../src/runtime/shutdown.js"

describe("server runtime", () => {
  it("Given installed media binaries When probed Then each receives its supported version flag", async () => {
    const invocations: string[] = []

    const result = await checkDependencies(async (file, args) => {
      invocations.push(`${file} ${args.join(" ")}`)
    })

    expect(result).toEqual({ ffmpeg: true, ytDlp: true })
    expect(invocations.sort()).toEqual(["ffmpeg -version", "yt-dlp --version"])
  })

  it("Given a missing media dependency When probed Then degraded availability is reported", async () => {
    const result = await checkDependencies(async (file) => {
      if (file === "yt-dlp") throw new Error("missing")
    })

    expect(result).toEqual({ ffmpeg: true, ytDlp: false })
  })

  it("Given missing production media binaries When startup asserts them Then exact commands are reported", () => {
    expect(() => assertDependencies({ ffmpeg: false, ytDlp: false })).toThrowError(
      new MissingDependencyError(["ffmpeg", "yt-dlp"]),
    )
  })

  it("Given repeated shutdown calls When executed Then each resource closes once", async () => {
    const closed: string[] = []
    const shutdown = createShutdown([
      {
        close: () => {
          closed.push("player")
        },
      },
      {
        close: async () => {
          closed.push("database")
        },
      },
    ])

    await Promise.all([shutdown(), shutdown(), shutdown()])

    expect(closed).toEqual(["player", "database"])
  })
})
