import type { Collection } from '../src/content'
import type { PreviewState } from '../src/runtime/preview'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $ } from 'bun'
import { describe, expect, it, spyOn } from 'bun:test'
import { t } from 'elysia'
import { collection } from '../src/content'
import { draftOf } from '../src/content/edit-entries'
import { entryHead, entryModified } from '../src/content/entry-head'
import { descriptionOf } from '../src/content/excerpt'
import { heldBack } from '../src/content/held-back'
import { bodiesFile, contentPlace, loadEntries, manifestFile, setContentMode, setContentPlace } from '../src/content/load'
import * as markdownModule from '../src/content/markdown'
import { gitSpawns } from '../src/content/modified'
import { slugsOf, writeContentManifests } from '../src/content/server'
import { html } from '../src/runtime/html'
import { setPreviewScope } from '../src/runtime/preview'
import { testEntry } from '../src/test'
import { scratchBuild } from './prerendered'

const schema = t.Object({ title: t.String(), description: t.Optional(t.String()), updatedAt: t.Optional(t.Date()) })

async function inProject<Result>(files: Record<string, string>, run: (root: string) => Promise<Result>): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), 'kay-excerpt-'))
  const before = contentPlace()

  try {
    setContentPlace(root, root)
    await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(root, name), text)))

    return await run(root)
  }
  finally {
    setContentPlace(before.root, before.base)
    await rm(root, { recursive: true, force: true })
  }
}

const post = (body: string) => `---\ntitle: T\n---\n\n${body}`

async function excerptOf(body: string): Promise<string> {
  return inProject({ 'p/a.md': post(body) }, async () => (await collection('p', { schema, components: { Box: () => html('') } }).get('a'))!.excerpt)
}

describe('an entry\'s excerpt', () => {
  it('is the first paragraph as plain text, past headings and with its markup and entities gone', async () => {
    expect(await excerptOf('# Title\n\nHello *big* [world](/w) &amp; `co`.\n\nSecond paragraph.\n')).toBe('Hello big world & co.')
  })

  it('takes every paragraph before a more marker', async () => {
    expect(await excerptOf('One.\n\nTwo.\n\n<!-- more -->\n\nThree.\n')).toBe('One. Two.')
    expect(await excerptOf('One.\n\n<!--more-->\n\nTwo.\n')).toBe('One.')
  })

  it('does not take a marker inside a code block or code span for one', async () => {
    expect(await excerptOf('One.\n\n```html\n<!-- more -->\n```\n\nTwo.\n\nUse `<!-- more -->` here.\n')).toBe('One.')
  })

  it('is empty for a body with no paragraph, and for a marker with none before it', async () => {
    expect(await excerptOf('# Only a heading\n\n- a list\n')).toBe('')
    expect(await excerptOf('<!-- more -->\n\nAfter.\n')).toBe('')
    expect(await excerptOf('')).toBe('')
  })

  it('leaves the paragraphs of a quote or a loose list out, nested quotes too', async () => {
    expect(await excerptOf('> quoted\n\nOne.\n')).toBe('One.')
    expect(await excerptOf('> outer\n>\n> > inner\n>\n> back in the outer one\n\nOne.\n')).toBe('One.')
    expect(await excerptOf('- a\n\n- b\n\nOne.\n')).toBe('One.')
  })

  it('leaves a component\'s own paragraphs out', async () => {
    expect(await excerptOf('<Box>\n\ninside\n\n</Box>\n\nOutside.\n')).toBe('Outside.')
  })

  it('is empty for a data file, with an empty body and html', async () => {
    await inProject({ 'd/a.json': '{"title":"T"}' }, async () => {
      const entry = (await collection('d', { schema }).get('a'))!

      expect([entry.excerpt, entry.body, entry.html]).toEqual(['', '', ''])
    })
  })

  it('keeps a more marker of a loader\'s untrusted body and html, past the sanitizer, but not one in a code fence', async () => {
    const rows = collection({ name: 'marked-rows', load: () => [
      { slug: 'b', data: { title: 'B' }, body: 'One.\n\nTwo.\n\n<!-- more -->\n\nThree.\n\n```\n<!-- more -->\n```\n' },
      { slug: 'f', data: { title: 'F' }, body: 'One.\n\n```\n<!-- more -->\n```\n\nTwo.\n' },
      { slug: 'h', data: { title: 'H' }, html: '<p>One.</p><p>Two.</p><!-- more --><p>Three.</p>' },
    ] }, { schema })

    expect((await rows.get('b'))!.excerpt).toBe('One. Two.')
    expect((await rows.get('b'))!.html).toContain('<!-- more -->')
    expect((await rows.get('b'))!.html).not.toContain('kay-more-marker')
    expect((await rows.get('f'))!.excerpt).toBe('One.')

    const glued = collection({ name: 'glued-rows', load: () => [
      { slug: 'a', data: { title: 'A' }, body: 'Lead\n<!-- more -->\nRest\n' },
      { slug: 'b', data: { title: 'B' }, body: 'Lead *one*.\n\n<!-- more -->\nRest\n' },
    ] }, { schema })

    expect((await glued.get('a'))!.excerpt).toBe('Lead')
    expect((await glued.get('b'))!.excerpt).toBe('Lead one.')
    expect((await glued.get('b'))!.html).toBe('<p>Lead <em>one</em>.</p>\n<!-- more -->\n<p>Rest</p>\n')
    expect((await rows.get('h'))!.excerpt).toBe('One. Two.')
  })

  it('is the first paragraph of a loader\'s html, and of its body', async () => {
    const loaded = collection({ name: 'lead-rows', load: () => [{ slug: 'h', data: { title: 'H' }, html: '<h2>x</h2><p>Lead <b>in</b>.</p><p>More</p>' }, { slug: 'b', data: { title: 'B' }, body: 'Lead.\n\nMore.\n' }] }, { schema })

    expect((await loaded.get('h'))!.excerpt).toBe('Lead in.')
    expect((await loaded.get('b'))!.excerpt).toBe('Lead.')
    expect((await loaded.get('b'))!.body).toBe('Lead.\n\nMore.\n')
  })
})

describe('an entry\'s body and html', () => {
  it('give the Markdown as written without its frontmatter, and what Content renders', async () => {
    await inProject({ 'p/a.md': post('# Hi\n\nText *here*.\n') }, async () => {
      const entry = (await collection('p', { schema }).get('a'))!

      expect(entry.body).toBe('# Hi\n\nText *here*.\n')
      expect(entry.html).toContain('<p>Text <em>here</em>.</p>')
      expect(entry.html).toBe((entry.Content({}) as { t: string }).t)
    })
  })

  it('are not listed as keys, so spreading an entry renders nothing', async () => {
    await inProject({ 'p/a.md': post('Text.\n') }, async () => {
      const entry = (await collection('p', { schema }).get('a'))!

      expect(Object.keys(entry)).not.toContain('html')
      expect(Object.keys(entry)).not.toContain('excerpt')
      expect(Object.keys({ ...entry })).not.toContain('html')
    })
  })
})

describe('a localized collection with a draft in preview', () => {
  it('keeps the excerpt and html of the entries it copies', async () => {
    const rows = collection({ name: 'copy-rows', load: () => [{ slug: 'fr/a', data: { title: 'A' }, body: 'Lead.\n' }, { slug: 'fr/b', data: { title: 'B' }, body: 'Other.\n' }] }, { schema, localized: true })
    const state: PreviewState = { loads: new Map(), edit: false, drafts: new Map([['copy-rows', [{ slug: 'b', locale: 'fr', data: { title: 'B2' } }]]]) }

    setPreviewScope(() => state)

    try {
      const entry = (await rows.all('fr')).find(row => row.slug === 'a')!

      expect([entry.excerpt, entry.html]).toEqual(['Lead.', '<p>Lead.</p>\n'])
      expect(entryHead(rows, entry).find(tag => tag.props.name === 'description')?.props.content).toBe('Lead.')
    }
    finally {
      setPreviewScope(() => undefined)
    }
  })
})

describe('the head description', () => {
  const head = async (data: Record<string, unknown>, body: string) => inProject({ 'p/a.md': post(body) }, async () => {
    const posts = collection('p', { schema })
    const entry = (await posts.get('a'))!

    return entryHead(posts, { ...entry, data, excerpt: entry.excerpt }).find(tag => tag.props.name === 'description')?.props.content
  })

  it('defaults to the excerpt when the entry has none', async () => {
    expect(await head({ title: 'T' }, 'Lead *text*.\n')).toBe('Lead text.')
  })

  it('keeps the entry\'s own description, and adds none for an entry with no paragraph', async () => {
    expect(await head({ title: 'T', description: 'Mine' }, 'Lead.\n')).toBe('Mine')
    expect(await head({ title: 'T' }, '# Only\n')).toBeUndefined()
  })

  it('cuts a long excerpt at a word', () => {
    const cut = descriptionOf(`${'word '.repeat(60)}end`)!

    expect(cut.length).toBeLessThanOrEqual(160)
    expect(cut.endsWith('word…')).toBe(true)
  })
})

describe('modified: \'mtime\' and \'git\'', () => {
  const files = { 'p/a.md': post('A.\n'), 'p/b.md': post('B.\n') }
  const at = (entry: { modified?: Date | undefined } | undefined) => entry?.modified?.toISOString()

  it('takes the file time for \'mtime\'', async () => {
    await inProject(files, async (root) => {
      await utimes(join(root, 'p/a.md'), new Date('2025-01-02T03:04:05Z'), new Date('2025-01-02T03:04:05Z'))

      const posts = collection('p', { schema, modified: 'mtime' })

      expect(at(await posts.get('a'))).toBe('2025-01-02T03:04:05.000Z')
      expect(entryModified(posts, (await posts.get('a'))!)?.toISOString()).toBe('2025-01-02T03:04:05.000Z')
    })
  })

  it('takes the last commit for \'git\', one call for all, and the file time for an untracked file or outside a repository', async () => {
    await inProject(files, async (root) => {
      const run = async (date: string, ...args: string[]) => $`git ${args}`.cwd(root).env({ ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }).quiet()

      await run('2024-01-01T00:00:00Z', 'init', '-q')
      await run('2024-01-01T00:00:00Z', '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'p/a.md')
      await run('2024-01-01T00:00:00Z', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a')
      await Bun.write(join(root, 'p/a.md'), post('A changed.\n'))
      await run('2024-06-01T00:00:00Z', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'a2')
      await utimes(join(root, 'p/a.md'), new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'))
      await utimes(join(root, 'p/b.md'), new Date('2025-05-05T00:00:00Z'), new Date('2025-05-05T00:00:00Z'))

      const posts = collection('p', { schema, modified: 'git' })

      expect(at(await posts.get('a'))).toBe('2024-06-01T00:00:00.000Z')
      expect(at(await posts.get('b'))).toBe('2025-05-05T00:00:00.000Z')
    })

    await inProject(files, async (root) => {
      await utimes(join(root, 'p/a.md'), new Date('2025-01-02T00:00:00Z'), new Date('2025-01-02T00:00:00Z'))

      expect(at(await collection('p', { schema, modified: 'git' }).get('a'))).toBe('2025-01-02T00:00:00.000Z')
    })
  })

  it('asks git once per HEAD, not once per load, and takes the time of a file edited since', async () => {
    await inProject(files, async (root) => {
      const run = async (date: string, ...args: string[]) => $`git ${args}`.cwd(root).env({ ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }).quiet()
      const commit = async (date: string) => run(date, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'c')

      await run('2024-01-01T00:00:00Z', 'init', '-q')
      await run('2024-01-01T00:00:00Z', 'add', '.')
      await commit('2024-01-01T00:00:00Z')

      const old = new Date('2025-01-01T00:00:00Z')

      await Promise.all(['a', 'b'].map(async name => utimes(join(root, `p/${name}.md`), old, old)))

      const posts = collection('p', { schema, modified: 'git' })
      const spawned = async (load: () => Promise<unknown>) => {
        const before = gitSpawns.count

        await load()

        return gitSpawns.count - before
      }

      // One `git rev-parse` for the HEAD and one `git log` for the history.
      expect(await spawned(async () => posts.all())).toBe(2)
      posts.invalidate()
      // The same HEAD: only the `git rev-parse`.
      expect(await spawned(async () => posts.all())).toBe(1)
      expect(at(await posts.get('a'))).toBe('2024-01-01T00:00:00.000Z')

      // A file edited while the server runs is dated by its time.
      await Bun.write(join(root, 'p/a.md'), post('A changed.\n'))
      posts.invalidate()
      expect(await spawned(async () => posts.all())).toBe(1)
      expect(new Date(at(await posts.get('a'))!).getTime()).toBeGreaterThan(Date.now() - 60_000)
      expect(at(await posts.get('b'))).toBe('2024-01-01T00:00:00.000Z')

      // A commit moves HEAD: the history is read again.
      await commit('2024-09-09T00:00:00Z')
      await utimes(join(root, 'p/a.md'), old, old)
      posts.invalidate()
      expect(await spawned(async () => posts.all())).toBe(2)
      expect(at(await posts.get('a'))).toBe('2024-09-09T00:00:00.000Z')
    })
  })

  it('reads a schema field of that name as the field, and a loader\'s entry has no file time', async () => {
    const field = t.Object({ title: t.String(), git: t.Date() })

    await inProject({ 'p/a.md': '---\ntitle: T\ngit: 2023-03-03\n---\n\nA.\n' }, async () => {
      const posts = collection('p', { schema: field, modified: 'git' })

      expect(at(await posts.get('a'))).toBeUndefined()
      expect(entryModified(posts, (await posts.get('a'))!)?.toISOString()).toBe('2023-03-03T00:00:00.000Z')
    })

    const loaded = collection({ name: 'plain-rows', load: () => [{ slug: 'a', data: { title: 'A' } }] }, { schema, modified: 'mtime' })

    expect((await loaded.get('a'))!.modified).toBeUndefined()
  })
})

describe('the prebuilt manifest', () => {
  it('keeps the Markdown bodies in a file of their own, read when an entry\'s body is', async () => {
    const root = resolve('tests/fixtures/content')
    const config = 'src/content.config.ts'
    const build = await scratchBuild({ contentConfig: config }, false, root)

    try {
      await writeContentManifests(root, build.dir, config)

      const manifest = await Bun.file(manifestFile(build.dir, 'content/posts')).json() as { file: string, body?: string }[]
      const bodies = await Bun.file(bodiesFile(build.dir, 'content/posts')).json() as Record<string, string>

      expect(manifest.length).toBeGreaterThan(0)
      expect(manifest.some(entry => 'body' in entry)).toBe(false)
      expect(Object.keys(bodies).sort()).toEqual(manifest.map(entry => entry.file).sort())

      setContentMode({ dev: false, prebuilt: true }, build.dir)

      const { posts } = await import(resolve(root, config)) as { posts: Collection<unknown> }
      const hello = (await posts.get('hello'))!

      expect(hello.body).toBe(bodies[hello.file]!)
      expect(hello.body.length).toBeGreaterThan(0)

      // A rebuild into the same folder is read afresh.
      await Bun.write(bodiesFile(build.dir, 'content/posts'), JSON.stringify({ [hello.file]: 'Rebuilt' }))

      const again = (await collection('content/posts', { schema: posts.options.schema, components: posts.components }).get('hello'))!

      expect(again.body).toBe('Rebuilt')
    }
    finally {
      setContentMode({ dev: false, prebuilt: false })
      await build.remove()
    }
  })
})

describe('testEntry', () => {
  it('fills every member of an entry a component takes, and lets a test set the ones it names', () => {
    const entry = testEntry({ title: 'T' }, { slug: 'hi', excerpt: 'Lead.' })

    expect(entry).toMatchObject({ slug: 'hi', data: { title: 'T' }, excerpt: 'Lead.', body: '', html: '', headings: [], words: 0, readingTime: 0, file: 'hi.md' })
    expect(testEntry({}).slug).toBe('entry')
  })
})

describe('a description of emoji', () => {
  it('is cut between characters, never inside a surrogate pair', () => {
    for (const lead of ['', 'x']) {
      const description = descriptionOf(lead + '😀'.repeat(200))!

      expect(description.isWellFormed()).toBe(true)
      expect(description.length).toBeLessThanOrEqual(160)
    }
  })
})

describe('collections whose folders overlap', () => {
  const files = { 'content/blog/a.md': post('Hello') }

  it('each give a slug relative to their own folder, whichever loads first', async () => {
    for (const order of [['content', 'content/blog'], ['content/blog', 'content']] as const) {
      await inProject(files, async () => {
        const slugs: Record<string, string[]> = {}

        for (const dir of order)
          slugs[dir] = (await loadEntries(dir, { live: true })).map(entry => entry.slug)

        expect(slugs).toEqual({ 'content': ['blog/a'], 'content/blog': ['a'] })
      })
    }
  })
})

describe('a draft function', () => {
  it('reads the entry\'s excerpt, body and html, as the app does', async () => {
    const seen: string[] = []
    const entry = Object.defineProperties({ slug: 'a', data: { title: 'T' } }, { excerpt: { get: () => 'WIP: x' }, body: { get: () => 'WIP body' }, html: { get: () => '<p>WIP</p>' } }) as unknown as Parameters<typeof heldBack>[1]
    const draft = (e: { excerpt: string, body: string, html: string }) => {
      seen.push(e.excerpt, e.body, e.html)

      return e.excerpt.startsWith('WIP')
    }

    expect(heldBack({ draft }, entry)).toBe(true)
    expect(seen).toEqual(['WIP: x', 'WIP body', '<p>WIP</p>'])
  })

  it('holds back a draft whose excerpt says so, in production and in the build\'s listing of slugs', async () => {
    await inProject({ 'p/a.md': post('WIP: later'), 'p/b.md': post('Done') }, async (root) => {
      const posts = collection('p', { schema, draft: entry => entry.excerpt.startsWith('WIP') })

      try {
        setContentMode({ dev: false, prebuilt: false })
        expect((await posts.all()).map(entry => entry.slug)).toEqual(['b'])
      }
      finally {
        setContentMode({ dev: false, prebuilt: false })
      }

      expect([...(await slugsOf(root, posts))!]).toEqual([['a', true], ['b', false]])
    })
  })
})

describe('the CMS\'s reading of a draft function', () => {
  it('gives it the entry\'s excerpt, body and html, as production does', async () => {
    await inProject({ 'p/a.md': post('WIP: later') }, async () => {
      const posts = collection('p', { schema, draft: entry => entry.excerpt.startsWith('WIP') && entry.body.includes('later') && entry.html.includes('<p>') })
      const source = (body: string) => ({ slug: 'a', path: 'p/a.md', data: { title: 'T' }, body })

      expect(await draftOf(posts, source('WIP: later'), { title: 'T' })).toBe(true)
      expect(await draftOf(posts, source('Done later'), { title: 'T' })).toBe(false)
    })
  })

  it('compiles the body only when the function reads the excerpt or html', async () => {
    await inProject({ 'p/a.md': post('x') }, async () => {
      const source = { slug: 'a', path: 'p/a.md', data: { title: 'T' }, body: 'Hello' }
      const compile = spyOn(markdownModule, 'compileMarkdown')

      try {
        expect(await draftOf(collection('p', { schema, draft: entry => entry.data.title === 'T' && entry.body === 'Hello' }), source, { title: 'T' })).toBe(true)
        expect(compile).not.toHaveBeenCalled()
        expect(await draftOf(collection('p', { schema, draft: entry => entry.excerpt === 'Hello' }), source, { title: 'T' })).toBe(true)
        expect(compile).toHaveBeenCalledTimes(1)
      }
      finally {
        compile.mockRestore()
      }
    })
  })
})
