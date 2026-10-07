import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { mail } from './mail'

export const app = new Elysia().use(mail).use(await pages())
