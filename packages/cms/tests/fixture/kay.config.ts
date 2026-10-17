import tailwind from 'bun-plugin-tailwind'
import { guard } from 'kay'
import { defineConfig } from 'kay/server'
import { cms } from '../../src/extension'
import { recorder } from './src/saved'

// The fixture lets everyone into the screens, keeps the files they save, and takes uploads of 64 KB at most.
export default defineConfig({
  extensions: [cms({ uploads: { maxSize: '64kb' }, guard: guard(() => undefined), files: recorder, author: () => ({ name: 'Fixture editor', email: 'editor@example.com' }) })],
  plugins: [tailwind],
  i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
  preview: { secret: 'a-preview-secret-long-enough-for-kay-0123456789' },
})
