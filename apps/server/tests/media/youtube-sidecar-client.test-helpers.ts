import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { afterEach } from "vitest"

type Handler = (request: IncomingMessage, response: ServerResponse) => void

export const opened: Array<() => Promise<void>> = []

export async function fakeServer(handler: Handler): Promise<{
  readonly url: string
  readonly close: () => Promise<void>
}> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("Expected TCP address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

export function environment(name: "HTTP_PROXY" | "HTTPS_PROXY"): string | undefined {
  return process.env[name]
}

export function setEnvironment(
  name: "HTTP_PROXY" | "HTTPS_PROXY",
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((close) => close()))
})
