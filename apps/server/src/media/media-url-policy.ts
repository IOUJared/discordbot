import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { z } from "zod"

const youtubeDeliveryHostname = /^(?:[a-z0-9-]+\.)*googlevideo\.com$/u
const youtubeDeliveryUrl = /^https?:\/\/(?:[a-z0-9-]+\.)*googlevideo\.com(?:[/?#]|$)/u

export const RemoteMediaUrlSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      youtubeDeliveryUrl.test(value) &&
      youtubeDeliveryHostname.test(url.hostname)
    )
  })
  .brand<"RemoteMediaUrl">()

export type RemoteMediaUrl = z.infer<typeof RemoteMediaUrlSchema>

export type ResolvedAddress = {
  readonly address: string
  readonly family: 4 | 6
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

export type AuthorizedRemoteUrl = {
  readonly url: RemoteMediaUrl
  readonly hostname: string
  readonly address: string
  readonly family: 4 | 6
  readonly port: number
}

export interface RemoteMediaPolicy {
  authorize(url: RemoteMediaUrl): Promise<AuthorizedRemoteUrl>
}

export class MediaPolicyError extends Error {
  readonly name = "MediaPolicyError"
}

const deniedIpv4Addresses = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  deniedIpv4Addresses.addSubnet(network, prefix, "ipv4")
}
const deniedIpv6Addresses = new BlockList()
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  deniedIpv6Addresses.addSubnet(network, prefix, "ipv6")
}

const nodeResolver: AddressResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }))
}

function isPublicAddress({ address, family }: ResolvedAddress): boolean {
  if (isIP(address) !== family) return false
  return family === 4
    ? !deniedIpv4Addresses.check(address, "ipv4")
    : !deniedIpv6Addresses.check(address, "ipv6")
}

export function createRemoteMediaPolicy(
  resolver: AddressResolver = nodeResolver,
): RemoteMediaPolicy {
  return {
    async authorize(value) {
      const url = new URL(RemoteMediaUrlSchema.parse(value))
      const addresses = await resolver(url.hostname)
      const first = addresses.at(0)
      if (first === undefined || !addresses.every(isPublicAddress)) {
        throw new MediaPolicyError("Remote media destination is not public")
      }
      return {
        url: value,
        hostname: url.hostname,
        address: first.address,
        family: first.family,
        port: url.protocol === "https:" ? 443 : 80,
      }
    },
  }
}

export const remoteMediaPolicy = createRemoteMediaPolicy()
