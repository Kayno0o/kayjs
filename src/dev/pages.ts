import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from '../server'

// The server a project with no entry of its own runs, as a static site does: its pages, on PORT.
const app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 3000))

// `kay dev` prints the address itself.
if (process.env.NODE_ENV === 'production')
  console.log(`Listening on http://localhost:${app.server?.port}`)
