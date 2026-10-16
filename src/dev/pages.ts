import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from '../server'

// The server a project with no entry of its own runs, as a static site does: its pages, on PORT and HOST.
new Elysia().use(await pages()).listen({ port: Number(process.env.PORT ?? 3000), ...process.env.HOST !== undefined && { hostname: process.env.HOST } })
