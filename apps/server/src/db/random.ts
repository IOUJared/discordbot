import { randomBytes } from "node:crypto"

export interface Random {
  token(): string
}

export const secureRandom: Random = {
  token: () => randomBytes(32).toString("base64url"),
}
