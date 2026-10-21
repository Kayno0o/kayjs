import { s } from 'kay'
import { defineEnv } from 'kay/server'

// Read once as the server boots. The secret is kay's own, KAY_SECRET, and the public origin its SITE_URL: neither is declared here.
export const env = defineEnv(s.Object({
  DATABASE_URL: s.String(),
  PORT: s.Integer({ default: 3000 }),
}))
