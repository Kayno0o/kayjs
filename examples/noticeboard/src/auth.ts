import { createAuth } from '@kaynooo/kayjs-auth'
import { pgStore } from '@kaynooo/kayjs-auth/pg'
import { db } from './db'
import { env } from './env'
import { mail } from './mail'
import { sessions } from './session'

// Passwords and mailed links, kept in Postgres beside the notices; its mails go through kayjs-mail's queue, which retries a mail server that is away.
export const auth = createAuth({
  sessions,
  secret: env.AUTH_SECRET,
  store: pgStore(db),
  url: env.SITE_URL,
  site: 'Noticeboard',
  signInPage: '/login',
  email: {
    mailer: { send: mail.enqueue },
    links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' },
  },
})
