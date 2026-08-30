import type { LoggerOptions } from "pino"

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "authorization",
        "token",
        "sessionToken",
        "code",
        "verifier",
        "clientSecret",
      ],
      censor: "[Redacted]",
    },
  }
}
