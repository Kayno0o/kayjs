import { Elysia } from 'elysia'

export default new Elysia().post('/', ({ body }) => body)
