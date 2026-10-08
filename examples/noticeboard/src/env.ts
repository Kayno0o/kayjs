import { t } from 'kay'
import { defineEnv } from 'kay/server'

// Read once as the server boots. The two secrets stay apart: kayjs-auth derives its keys from AUTH_SECRET, the session seals its cookie with SESSION_SECRET.
export const env = defineEnv(t.Object({
  SESSION_SECRET: t.String({ minLength: 32 }),
  AUTH_SECRET: t.String({ minLength: 32 }),
  DATABASE_URL: t.String(),
  // The public origin mailed links start with.
  SITE_URL: t.String({ default: 'http://localhost:3000' }),
  PORT: t.Integer({ default: 3000 }),
}))
