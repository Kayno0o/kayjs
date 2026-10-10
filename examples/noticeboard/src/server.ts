import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { auth } from './auth'
import { env } from './env'
import { announcements } from './jobs'
import { mail } from './mail'

// Exported for `kay check`, which types `ctx.locals` from the plugins and checks links to their routes. The mailer and the queue run their jobs in this process.
export const app = new Elysia().use(auth.plugin).use(mail).use(announcements).use(await pages()).listen(env.PORT)
