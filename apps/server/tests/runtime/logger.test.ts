import { Writable } from "node:stream"

import pino from "pino"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { loggerOptions } from "../../src/logger.js"

const logSchema = z.object({
  authorization: z.string(),
  token: z.string(),
  err: z.object({ type: z.string(), message: z.string(), stack: z.string() }),
})

describe("structured logging", () => {
  it("Given an error and credentials When serialized Then secrets redact and the stack remains", () => {
    let output = ""
    const sink = new Writable({
      write: (chunk, _encoding, done) => {
        output += chunk.toString()
        done()
      },
    })
    const logger = pino(loggerOptions("info"), sink)

    logger.error(
      { authorization: "Bearer private", token: "private", err: new Error("failure") },
      "request.failed",
    )

    const parsed = logSchema.parse(JSON.parse(output))
    expect(parsed.authorization).toBe("[Redacted]")
    expect(parsed.token).toBe("[Redacted]")
    expect(parsed.err.type).toBe("Error")
    expect(parsed.err.stack).toContain("failure")
  })
})
