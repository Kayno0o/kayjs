import tailwind from 'bun-plugin-tailwind'
import { guard } from 'kay'
import { defineConfig } from 'kay/server'
import { cms } from '../../src/extension'
import { highlight } from './src/highlight'
import { recorder } from './src/saved'

// The fixture lets everyone into the screens, but a request carrying `x-deny`, keeps the files they save, and takes uploads of 64 KB at most.
export default defineConfig({
  extensions: [cms({ collections: { scratch: { history: false }, shop: { form: { fields: ['price', ['stock', 'live'], 'photo'], hide: ['sku', 'position'] }, list: { columns: ['price', 'live'], actions: ['delete'] } } }, uploads: { maxSize: '64kb' }, guard: guard(ctx => (ctx.request.headers.has('x-deny') ? ctx.deny(403, 'Denied') : undefined)), files: recorder, author: ({ url }) => ({ name: url.searchParams.get('as') ?? 'Fixture editor', email: 'editor@example.com' }) })],
  plugins: [tailwind],
  markdown: { highlight },
  i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
  preview: { secret: 'a-preview-secret-long-enough-for-kay-0123456789' },
})
