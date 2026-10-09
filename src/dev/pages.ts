import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from '../server'

// The server `kay dev` runs for a project with no entry of its own, as a static site is: its pages, on PORT.
const app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 3000))

console.log(`Listening on http://localhost:${app.server?.port}`)
