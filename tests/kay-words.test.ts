import type { Action } from '../src/runtime'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { libraryMessageExtensions } from '../src/build/manifests'
import { messageProblems } from '../src/check/messages'
import { sizeText } from '../src/runtime/size-text'
import { wording } from '../src/runtime/words.server'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const FIXTURE = 'tests/fixtures/kay-words'
const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages: 'src/messages' }
const site = await testSite({ root: FIXTURE, i18n, maxSize: 1024 * 1024 })
const { check, listed, guarded, owned, boom } = await import(join(import.meta.dir, 'fixtures/kay-words/src/routes/index.kay')) as {
  check: Action<Record<string, string>, unknown>
  listed: Action<Record<string, string | string[]>, unknown>
  guarded: Action<Record<string, string>, unknown, 'website'>
  owned: Action<Record<string, string>, unknown, 'website'>
  boom: Action<Record<string, never>, unknown>
}

const REFUSED = { name: 'ab', nick: 'abcd', code: 'y', age: '3' }

describe('kay\'s refusals in the app\'s catalogs', () => {
  it('words a schema refusal by its kind with the limit filled in, and leaves a kind without a key and a field\'s own error as they were', async () => {
    const french = await site.submit(check, REFUSED, { from: '/fr' })

    expect(french.status).toBe(422)
    expect(french.html).toContain('Au moins 3 caractères')
    expect(french.html).toContain('Au plus 2 caractères')
    expect(french.html).toContain('18 ou plus')
    expect(french.html).toContain('Champ requis')
    expect(french.html).toContain('Expected string to match')
    expect(french.html).toContain('Mine')
  })

  it('words a format, a pattern, too few and too many items each under its own key', async () => {
    const refused = { mail: 'nope', tags: ['a'], extra: ['a', 'b'], slug: 'y', flag: 'maybe', after: 'abc' }
    const french = await site.submit(listed, refused, { from: '/fr' })
    const english = await site.submit(listed, refused, { from: '/' })

    expect(french.html).toContain('Pas au format email')
    expect(french.html).toContain('Au moins 2 choix')
    expect(french.html).toContain('Au plus 1 choix')
    // The pattern comes first for a field with both, and has no key here.
    expect(french.html).toContain('Expected string to match')
    // A pattern the value passes leaves the format to speak, and Elysia's own BooleanString format is not named.
    expect(french.html.match(/Pas au format/g)).toHaveLength(2)
    expect(french.html).not.toContain('format boolean')
    expect(english.html).not.toContain('choix')
    expect(english.html).toContain('Expected array length')
  })

  it('shows Elysia\'s wording on a site whose catalogs have no kay keys', async () => {
    const english = await site.submit(check, REFUSED, { from: '/' })

    expect(english.html).toContain('Expected string length greater or equal to 3')
    expect(english.html).toContain('Expected string length less or equal to 2')
    expect(english.html).toContain('Property \'age\'')
    expect(english.html).not.toContain('ou plus')
    expect(english.html).not.toContain('Champ requis')
  })

  it('words the honeypot and the rate limit, and a per-action message wins over the catalog', async () => {
    const english = await site.submit(guarded, { website: 'spam' }, { from: '/' })
    const french = await site.submit(guarded, { website: 'spam' }, { from: '/fr' })
    const own = await site.submit(owned, { website: 'spam' }, { from: '/fr' })

    expect(english.html).toContain('Leave this field empty')
    expect(french.html).toContain('Laissez ce champ vide')
    expect(own.html).toContain('Own words')
    expect(own.html).not.toContain('Laissez')
  })

  it('words the rate limit with the wait and the body limit with the size', async () => {
    await site.submit(guarded, {}, { from: '/fr' })

    const limited = await site.submit(guarded, {}, { from: '/fr' })
    const large = await site.submit(guarded, { website: '', filler: 'x'.repeat(2000) }, { from: '/fr' })

    expect(limited.status).toBe(429)
    expect(limited.html).toMatch(/Trop d(&#39;|&#x27;|')essais, réessayez dans \d+ s/)
    expect(large.html).toMatch(/Trop volumineux, 200\s+octets au plus/)
  })

  it('words the server error when a handler throws', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const english = await site.submit(boom, {}, { from: '/' })
      const french = await site.submit(boom, {}, { from: '/fr' })

      expect(english.html).toContain('Something went wrong on our side; try again later')
      expect(french.html).toContain('Une erreur est survenue de notre côté')
    }
    finally {
      error.mockRestore()
    }
  })
})

describe('sizeText', () => {
  it('writes the units of the locale', () => {
    expect(sizeText(200)).toBe('200 bytes')
    expect(sizeText(512 * 1024)).toBe('512 KB')
    expect(sizeText(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(sizeText(1.5 * 1024 * 1024, 'fr')).toMatch(/^1,5\sMo$/)
    expect(sizeText(200, 'fr')).toMatch(/^200\soctets$/)
  })
})

describe('the offline page', () => {
  it('is worded in the default locale, in English without the keys', async () => {
    const keys = { root: FIXTURE, prebuilt: false, offline: true as const }
    const english = await offlinePage(await pages({ ...keys, i18n }))
    const french = await offlinePage(await pages({ ...keys, i18n: { ...i18n, defaultLocale: 'fr' } }))

    expect(english).toContain('<html lang="en"')
    expect(english).toContain('<h1>Offline</h1><p>This page needs a connection, and none is open.</p>')
    expect(french).toContain('<html lang="fr"')
    expect(french).toContain('<h1>Hors ligne</h1>')
    expect(french).toContain('aucune n\'est ouverte')
  })
})

describe('kay check on the catalogs', () => {
  it('compares the placeholders of a library message the default locale does not word with its English, and takes auth.*, mail.* and ai.* keys alone', async () => {
    const root = await scratchDir('kay-words-check-')
    const messages = join(root, 'messages')
    const write = async (locale: string, body: string) => Bun.write(join(messages, `${locale}.ts`), `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages(${body})\n`)

    await write('en', '{ title: \'Words\' }')
    await write('fr', `{
  title: 'Mots',
  kay: { action: { bodyLimit: 'Trop gros', serverError: 'Erreur {code}' }, invalid: { tooShort: 'Au moins {min}', tooLong: 'Au plus {min}' } },
  ui: { table: { selectedLabel: { one: 'une', other: '{count} choisies' }, filterLabel: 'Filtre {x}', selectAllLabel: 'Tout' } },
  cms: { table: { deleteMessage: 'Supprimer {title} ?' } },
  auth: { scopes: { read: 'Lire' }, other: 'Autre' },
  mail: { contact: { sent: 'Envoyé' } },
  ai: { chat: { disclosure: 'Vous parlez à une IA {x}' }, other: 'Autre' },
}`)

    const problems = (await messageProblems(process.cwd(), { locales: ['en', 'fr'], defaultLocale: 'en', messages: relative(process.cwd(), messages) })).map(problem => problem.message)

    expect(problems.toSorted()).toEqual([
      'gives kay.action.bodyLimit without {size}, which its English has',
      'gives kay.action.serverError a {code}, which its English has not, so nothing fills it',
      'gives kay.invalid.tooLong a {min}, which its English has not, so nothing fills it',
      'gives kay.invalid.tooLong without {max}, which its English has',
      'gives ui.table.filterLabel a {x}, which its English has not, so nothing fills it',
      'gives ai.chat.disclosure a {x}, which its English has not, so nothing fills it',
    ].toSorted())
  })

  it('reports a French delete question of the entry screen that names no entry, as the key takes {title}', async () => {
    const root = await scratchDir('kay-words-delete-')
    const messages = join(root, 'messages')
    const write = async (locale: string, body: string) => Bun.write(join(messages, `${locale}.ts`), `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages(${body})\n`)

    await write('en', '{ title: \'Words\' }')
    await write('fr', '{ title: \'Mots\', cms: { entry: { deleteMessage: \'Supprimer cette entrée ?\' }, table: { deleteMessage: \'Supprimer {title} ?\' } } }')

    const problems = (await messageProblems(process.cwd(), { locales: ['en', 'fr'], defaultLocale: 'en', messages: relative(process.cwd(), messages) })).map(problem => problem.message)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('cms.entry.deleteMessage without {title}')
  })

  it('asks a locale no installed library ships for none of its keys, which read the default locale\'s', async () => {
    const root = await scratchDir('kay-words-libraries-')
    const write = async (locale: string, body: string) => Bun.write(join(root, 'src/messages', `${locale}.ts`), `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages(${body})\n`)

    try {
      await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@kaynooo/kayjs-ui': 'workspace:*', '@kaynooo/kayjs-mail': 'workspace:*' } }))
      await mkdir(join(root, 'node_modules/@kaynooo'), { recursive: true })
      await symlink(join(import.meta.dir, '../packages/ui'), join(root, 'node_modules/@kaynooo/kayjs-ui'))
      await symlink(join(import.meta.dir, '../packages/mail'), join(root, 'node_modules/@kaynooo/kayjs-mail'))
      await write('en', '{ title: \'Words\', bye: \'Bye\' }')
      await write('fr', '{ title: \'Mots\', bye: \'Salut\' }')
      await write('de', '{ title: \'Wörter\' }')
      const extensions = libraryMessageExtensions(root)

      expect(extensions.map(({ name }) => name).toSorted()).toEqual(['@kaynooo/kayjs-mail', '@kaynooo/kayjs-ui'])

      // kayjs-ui ships fr alone and kayjs-mail en and fr: de is held to the app's own keys.
      for (const defaultLocale of ['en', 'fr'])
        expect((await messageProblems(root, { locales: ['en', 'fr', 'de'], defaultLocale }, extensions)).map(({ file, message }) => `${file}: ${message}`)).toEqual([`src/messages/de.ts: lacks bye, which src/messages/${defaultLocale}.ts has`])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets a locale word the kay.* keys the default locale does not give', async () => {
    expect(await messageProblems(process.cwd(), { ...i18n, messages: resolve(`${FIXTURE}/src/messages`) })).toEqual([])
  })
})

// The page the worker falls back to, from its settings.
async function offlinePage(app: { handle: (request: Request) => Promise<Response> }): Promise<string> {
  const script = await (await app.handle(new Request('http://localhost/sw.js'))).text()

  return (JSON.parse((/^const KAY = (.+)$/m).exec(script)![1]!) as { offline: string }).offline
}

describe('wording', () => {
  it('writes a date param the way the page\'s locale does, in the English too', async () => {
    const day = new Date(Date.UTC(2026, 9, 4, 12))
    const { runInLocale } = await import('../src/runtime/locale-state')

    expect(wording('kay.none', 'Since {day}', { day })).toBe('Since Oct 4, 2026')
    expect(runInLocale({ locale: 'fr', messages: new Map(), settings: { locales: ['fr'], defaultLocale: 'fr', prefixDefault: false }, path: '/' }, () => wording('kay.none', 'Since {day}', { day }))).toBe('Since 4 oct. 2026')
    expect(runInLocale({ locale: 'fr', messages: new Map([['kay.since', 'Depuis le {day}']]), settings: { locales: ['fr'], defaultLocale: 'fr', prefixDefault: false }, path: '/' }, () => wording('kay.since', 'Since {day}', { day }))).toBe('Depuis le 4 oct. 2026')
  })

  it('is the English with its placeholders filled outside a request', () => {
    expect(wording('kay.none', 'Up to {max} of {n}', { max: 5, n: 'a' })).toBe('Up to 5 of a')
    expect(wording('kay.none', 'Go to {n}')).toBe('Go to {n}')
  })
})

describe('the kay.* keys in llms', () => {
  it('lists every text kay words and every kind of schema refusal', async () => {
    const source = await Bun.file(join(import.meta.dir, '../src/server/words.ts')).text()
    const doc = await Bun.file(join(import.meta.dir, '../llms/locales.md')).text()
    const keys = [...source.matchAll(/'kay\.([\w.]+)'/g)].map(match => match[1]!)

    expect(keys.length).toBeGreaterThan(15)

    expect(keys.filter(key => !key.startsWith('invalid.') && !doc.includes(`\`${key}\``))).toEqual([])

    for (const kind of ['required', 'tooShort', 'tooLong', 'pattern', 'format', 'tooFewItems', 'tooManyItems', 'tooSmall', 'tooBig', 'type'])
      expect(doc).toContain(`\`${kind}\``)
  })
})

describe('sizeText from kay/words', () => {
  it('writes a size in the page locale, English outside a request', async () => {
    const { sizeText: inPage } = await import('../src/runtime/words.server')

    expect(inPage(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(inPage(200, 'fr')).toMatch(/^200\soctets$/)
  })
})
