import ky from "ky"
import { z } from "zod"

const tokenSchema = z.object({ access_token: z.string().min(1) })
const userSchema = z.object({ id: z.string().min(1), username: z.string().min(1) })

export type DiscordIdentity = Readonly<z.infer<typeof userSchema>>

export interface DiscordOAuth {
  exchange(code: string, verifier: string): Promise<DiscordIdentity>
  isGuildMember(userId: string): Promise<boolean>
}

export type DiscordOAuthOptions = {
  readonly apiUrl: string
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly guildId: string
  readonly botToken: string
}

export class KyDiscordOAuth implements DiscordOAuth {
  constructor(private readonly options: DiscordOAuthOptions) {}

  async exchange(code: string, verifier: string): Promise<DiscordIdentity> {
    const token = tokenSchema.parse(
      await ky
        .post(`${this.options.apiUrl}/oauth2/token`, {
          timeout: 10_000,
          retry: 0,
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            client_id: this.options.clientId,
            client_secret: this.options.clientSecret,
            redirect_uri: this.options.redirectUri,
          }),
        })
        .json(),
    )
    return userSchema.parse(
      await ky
        .get(`${this.options.apiUrl}/users/@me`, {
          timeout: 10_000,
          retry: 0,
          headers: { authorization: `Bearer ${token.access_token}` },
        })
        .json(),
    )
  }

  async isGuildMember(userId: string): Promise<boolean> {
    const response = await ky.get(
      `${this.options.apiUrl}/guilds/${encodeURIComponent(this.options.guildId)}/members/${encodeURIComponent(userId)}`,
      {
        timeout: 10_000,
        retry: 0,
        throwHttpErrors: false,
        headers: { authorization: `Bot ${this.options.botToken}` },
      },
    )
    return response.status === 200
  }
}
