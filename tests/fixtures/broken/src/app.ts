import { Elysia } from 'elysia'

export const app = new Elysia()
  .get('/api/feed.xml', () => '<rss />')
  .post('/api/import', () => 'ok')
  .group('/auth', auth => auth.get('/:provider', ({ params }) => params.provider))
  .get('/files/*', () => 'file')

declare module 'kay' {
  interface Register {
    app: typeof app
  }
}
