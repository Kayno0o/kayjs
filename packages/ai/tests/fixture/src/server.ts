import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().use(await pages())
