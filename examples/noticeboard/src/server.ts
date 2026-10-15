import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { env } from './env'
import { announcements } from './jobs'

// Exported for `kay check`. The auth and mail extensions in kay.config.ts add their plugins before the pages, which type `ctx.locals`; the mailer and the queue run their jobs in this process.
export const app = new Elysia().use(announcements).use(await pages()).listen(env.PORT)
