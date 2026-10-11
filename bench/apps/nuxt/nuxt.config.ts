import { join } from 'node:path'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  app: { head: { htmlAttrs: { lang: 'en' } } },
  // Nitro's Bun preset with an entry the bench calls in-process, instead of the one starting a server.
  nitro: { preset: 'bun', entry: join(import.meta.dirname, 'entry.ts') },
})
