import { s } from 'kay'
import { defineEnv } from 'kay/server'

// Read once as the server boots. The two secrets stay apart: kayjs-auth derives its keys from AUTH_SECRET, the session seals its cookie with SESSION_SECRET.
export const env = defineEnv(s.Object({
  SESSION_SECRET: s.String({ minLength: 32 }),
  AUTH_SECRET: s.String({ minLength: 32 }),
  DATABASE_URL: s.String(),
  // The public origin mailed links start with.
  SITE_URL: s.String({ default: 'http://localhost:3000' }),
  PORT: s.Integer({ default: 3000 }),
}))
