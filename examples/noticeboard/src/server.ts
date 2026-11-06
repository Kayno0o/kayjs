import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { env } from './env'

// Exported for `kay check`. The auth and mail extensions in kay.config.ts and `src/plugins` add their plugins before the pages, which type `ctx.locals`; the mailer and the queue run their jobs in this process.
export const app = new Elysia().use(await pages()).listen(env.PORT)
