import { describe, expect, it } from "vitest"

import {
  type AddressResolver,
  createRemoteMediaPolicy,
  RemoteMediaUrlSchema,
} from "../../src/media/media-url-policy.js"

const remoteUrl = "https://rr1---sn-a5mekn7z.googlevideo.com/videoplayback?id=abc"

describe("remote media URL policy", () => {
  it.each([
    "file:///etc/passwd",
    "https://127.0.0.1/audio",
    "https://[::1]/audio",
    "https://2130706433/audio",
    "https://0177.0.0.1/audio",
    "https://user:secret@rr1---sn-a5mekn7z.googlevideo.com/audio",
    "https://rr1---sn-a5mekn7z.googlevideo.com:443/audio",
    "https://rr1---sn-a5mekn7z.googlevideo.com:8443/audio",
    "https://googlevideo.com.attacker.example/audio",
  ])("rejects a non-delivery URL: %s", (value) => {
    // Given: a URL outside the YouTube media-delivery authority.
    // When: the resolved media value crosses the parser boundary.
    const result = RemoteMediaUrlSchema.safeParse(value)
    // Then: the value cannot reach a network sink.
    expect(result.success).toBe(false)
  })

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ])("rejects a delivery hostname resolving to %s", async (address) => {
    // Given: an allowed hostname whose resolver returns a non-public address.
    const resolver: AddressResolver = async () => [
      { address, family: address.includes(":") ? 6 : 4 },
    ]
    const policy = createRemoteMediaPolicy(resolver)

    // When: the sink authorizes and pins the target.
    const authorize = policy.authorize(RemoteMediaUrlSchema.parse(remoteUrl))

    // Then: private and reserved destinations are rejected.
    await expect(authorize).rejects.toThrow()
  })

  it("pins a public DNS answer for the network request", async () => {
    // Given: a YouTube delivery hostname with a public address.
    const resolver: AddressResolver = async () => [{ address: "142.250.190.78", family: 4 }]
    const policy = createRemoteMediaPolicy(resolver)

    // When: the URL is authorized immediately before the request.
    const target = await policy.authorize(RemoteMediaUrlSchema.parse(remoteUrl))

    // Then: the request target contains the checked address and original hostname.
    expect(target).toMatchObject({
      address: "142.250.190.78",
      family: 4,
      hostname: "rr1---sn-a5mekn7z.googlevideo.com",
    })
  })

  it("rejects a private answer when the hostname is re-resolved", async () => {
    // Given: a resolver that changes from public to loopback between checks.
    let resolution = 0
    const resolver: AddressResolver = async () => {
      resolution += 1
      return resolution === 1
        ? [{ address: "142.250.190.78", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }]
    }
    const policy = createRemoteMediaPolicy(resolver)
    const url = RemoteMediaUrlSchema.parse(remoteUrl)
    await policy.authorize(url)

    // When: the sink re-authorizes the same hostname.
    const authorizeAgain = policy.authorize(url)

    // Then: DNS rebinding cannot reuse the earlier authority.
    await expect(authorizeAgain).rejects.toThrow()
  })
})
