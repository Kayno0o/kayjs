import { Elysia } from 'elysia'
import { pages } from 'kay/server'

// Exported for `kay check`, which checks links against the routes it serves besides the pages.
export const app = new Elysia().use(await pages())
