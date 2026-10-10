import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

// Exported for `kay check`, which checks links against the routes it serves besides the pages.
export const app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 3000))
