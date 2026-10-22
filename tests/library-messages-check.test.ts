import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { kayCheck } from './check-helper'
import { scratchDir } from './scratch'

const TIMEOUT = 120_000
const projects: string[] = []

const MESSAGES = (tree: string) => `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages(${tree})\n`

// An app rendering kayjs-mail's contact mail, so `kay check` types the `t('mail.contact...')` calls inside it against the app's own `Messages`, with the libraries as the workspace links them.
async function project(libraries: string[], config: string, own: Record<string, string> = {}): Promise<string> {
  const root = await scratchDir('library-messages-check-')

  projects.push(root)

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: Object.fromEntries(libraries.map(name => [`@kaynooo/kayjs-${name}`, '*'])) }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
    'kay.config.ts': config,
    'src/routes/index.kay': '---\nimport ContactMail from \'@kaynooo/kayjs-mail/contact-mail.kay\'\n---\nContactMail(subject="Hello" name="Ada" email="ada@example.com" message="Hi" fields={[]} site="https://example.com" origin="https://example.com")\n',
    ...own,
  }

  await Promise.all(Object.entries(files).map(async ([path, text]) => Bun.write(join(root, path), text)))

  return root
}

afterAll(async () => {
  await Promise.all(projects.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function check(root: string): Promise<{ code: number, output: string }> {
  const { code, output, report } = await kayCheck([root])

  return { code, output: `${report}${output}` }
}

const CLEAN = /checked with no problems in \d+ ms/
const I18N = 'export default { i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }\n'
const APP_EN = { 'src/messages/en.ts': MESSAGES('{ home: \'Home\' }') }
const APP_FR = { 'src/messages/fr.ts': MESSAGES('{ home: \'Accueil\' }') }

// kayjs-ui's catalog types `t` once it is installed, so kayjs-mail's own texts have to be in it too, or a mail component it ships fails the app's check.
describe('kayjs-mail\'s texts next to another library\'s catalog', () => {
  it('check an app on kayjs-ui and kayjs-mail with no i18n, in French', async () => {
    const root = await project(['ui', 'mail'], 'export default { lang: \'fr\' }\n')
    const { code, output } = await check(root)

    expect(output.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('check the same app in English', async () => {
    const root = await project(['ui', 'mail'], 'export default { lang: \'en\' }\n')
    const { code, output } = await check(root)

    expect(output.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('check an app with i18n on English and French and no file of its own, the libraries wording English inline', async () => {
    const { code, output } = await check(await project(['ui', 'mail'], I18N, {}))

    expect(output.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('check an app with i18n on English and French', async () => {
    const { code, output } = await check(await project(['ui', 'mail'], I18N, { ...APP_EN, ...APP_FR }))

    expect(output.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('check an app that words one mail.contact key itself, the others staying kayjs-mail\'s', async () => {
    const root = await project(['ui', 'mail'], 'export default { lang: \'fr\' }\n', { 'src/messages/fr.ts': MESSAGES('{ mail: { contact: { footer: \'Envoyé depuis {origin}, répondre écrit à {name}.\' } } }') })
    const { code, output } = await check(root)

    expect(output.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('check an app on kayjs-mail alone', async () => {
    const french = await check(await project(['mail'], 'export default { lang: \'fr\' }\n'))
    const english = await check(await project(['mail'], 'export default {}\n'))

    expect(french.output.slice(0, 600)).toMatch(CLEAN)
    expect(english.output.slice(0, 600)).toMatch(CLEAN)
    expect([french.code, english.code]).toEqual([0, 0])
  }, TIMEOUT)

  it('still refuse a key neither the library nor the app words', async () => {
    const root = await project(['ui', 'mail'], 'export default { lang: \'fr\' }\n', { 'src/routes/missing.kay': '---\nimport { t } from \'kay/i18n\'\n---\np {t(\'mail.contact.nope\')}\n' })
    const { code, output } = await check(root)

    expect(output).toContain('mail.contact.nope')
    expect(code).toBe(1)
  }, TIMEOUT)
})
