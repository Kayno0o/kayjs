import { createAuth } from '@kaynooo/kayjs-auth'
import { pgStore } from '@kaynooo/kayjs-auth/pg'
import { authMailer } from '@kaynooo/kayjs-mail'
import { db } from './db'
import { env } from './env'
import { mail } from './mail'
import { sessions } from './session'

// Passwords and mailed links, kept in Postgres beside the notices, on kayjs-auth's own pages; its mails go through kayjs-mail's queue, which retries a mail server that is away.
export const auth = createAuth({
  sessions,
  secret: env.AUTH_SECRET,
  store: pgStore(db),
  url: env.SITE_URL,
  site: 'Noticeboard',
  pages: true,
  email: {
    mailer: authMailer(mail.enqueue),
    // Members join signed in, and confirm their address to hear of new notices; joining with a taken address says so.
    requireVerified: false,
  },
})
