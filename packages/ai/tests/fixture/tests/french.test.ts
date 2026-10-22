import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const french = await testSite({ root: ROOT, islands: false, i18n: { locales: ['fr'], defaultLocale: 'fr' } })

test('the chat words its labels in French from the library\'s own catalog, and a label prop still overrides', async () => {
  // A French page writes a no-break space before `?`.
  const page = await french.visit('/launcher/one')
  const html = page.html.replaceAll(/[\u00A0\u202F]/g, ' ')

  expect(page.html).toContain('Ouvrir le chat')
  expect(page.html).toContain('Nouvelle conversation')
  expect(html).toContain('Comment puis-je vous aider ?')
  expect(page.html).toContain('placeholder="Écrivez un message…"')
  expect(page.html).toContain('Vous discutez avec une IA')

  const named = await french.visit('/assistant')

  expect(named.html).toContain('aria-label="Assistant"')
  expect(named.html).not.toContain('Write a message')
})
