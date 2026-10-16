import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { dev } from '../src/dev'
import { planReload } from '../src/dev/reload'
import { scratchDir } from './scratch'

// What a reload of the running process costs on a small site, with the time `kay dev` reports for it: a new process costs about 250 ms on an idle machine, so the best of a few edits stays under it even when the machine is busy.
const RELOAD_BUDGET_MS = 250
const EDITS = 4

async function until(condition: () => boolean | Promise<boolean>, timeout = 15_000) {
  for (const start = Date.now(); !await condition(); await Bun.sleep(10)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

it('reloads a server component, a post and a dependency of the content config in place, within the budget', async () => {
  const root = await scratchDir('dev-reload-speed-')
  const probe = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })
  const { port } = probe
  const lines: string[] = []

  probe.stop(true)

  await Promise.all(Object.entries({
    'src/dep.ts': 'export const label = \'one\'\n',
    'src/components/note.kay': 'aside Note one\n',
    'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\nimport Note from \'./components/note.kay\'\n\nexport { label } from \'./dep\'\nexport const posts = collection(\'content/posts\', { schema: t.Object({ title: t.String() }), components: { Note } })\n',
    'src/content/posts/hello.md': '---\ntitle: Hello\n---\n\nBody 0\n\n<Note />\n',
    'src/routes/index.kay': '--- server\nimport { label, posts } from \'../content.config\'\n\nconst post = await posts.get(\'hello\')\nconst { Content } = post!\n---\nh1 {post!.data.title}\np {label}\nContent\n',
  }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  const stop = await dev(root, { port, log: line => lines.push(line) })
  const reloads = () => lines.filter(line => (/reloaded in \d+ ms$/).test(line))
  const page = async () => {
    try {
      return await (await fetch(`http://localhost:${port}/`)).text()
    }
    catch {
      return ''
    }
  }

  try {
    await until(() => lines.some(line => line.includes('ready in')))
    await until(async () => (await page()).includes('Body 0'))

    const edit = async (path: string, content: (index: number) => string, seen: (index: number) => string) => {
      const times: number[] = []

      for (let index = 1; index <= EDITS; index++) {
        const before = reloads().length

        await Bun.write(join(root, path), content(index))
        await until(() => reloads().length > before)
        await until(async () => seen(index) === '' || (await page()).includes(seen(index)))

        const line = lines.at(-1)!

        expect(line).toMatch(/reloaded in \d+ ms$/)
        times.push(Number((/in (\d+) ms$/).exec(line)![1]))
        // The next edit comes once this one's burst is over.
        await Bun.sleep(50)
      }

      return Math.min(...times)
    }

    const component = await edit('src/components/note.kay', index => `aside Note ${index + 1}\n`, index => `Note ${index + 1}`)
    const post = await edit('src/content/posts/hello.md', index => `---\ntitle: Hello\n---\n\nBody ${index}\n\n<Note />\n`, index => `Body ${index}`)
    const dependency = await edit('src/dep.ts', index => `export const label = 'v${index}'\n`, index => `v${index}`)

    expect(component).toBeLessThan(RELOAD_BUDGET_MS)
    expect(post).toBeLessThan(RELOAD_BUDGET_MS)
    expect(dependency).toBeLessThan(RELOAD_BUDGET_MS)
    expect(lines.filter(line => line.includes('restarted'))).toEqual([])
  }
  finally {
    await stop()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it('plans an entry of a collection, and what the content config imports, as a reload of the config and the pages reading it', async () => {
  const root = await scratchDir('dev-reload-plan-')

  await Promise.all(Object.entries({
    'src/dep.ts': 'export const label = \'one\'\n',
    'src/content.config.ts': 'import { label } from \'./dep\'\n\nexport const posts = label\n',
    'src/routes/index.kay': '--- server\nimport { posts } from \'../content.config\'\n---\np {posts}\n',
    'src/content/posts/hello.md': 'Hello\n',
    'src/data.json': '{}\n',
    'notes/todo.md': 'Todo\n',
  }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  try {
    const base = await realpath(root)
    const content = join(base, 'src/content.config.ts')
    const page = join(base, 'src/routes/index.kay')
    const dep = join(base, 'src/dep.ts')
    const input = { root, loaded: [content, page, dep], owned: [join(base, 'src/routes')], content: { file: content, folders: [join(base, 'src/content/posts')] }, config: join(base, 'kay.config.ts'), entry: join(base, 'src/server.ts') }

    for (const changed of [['src/content/posts/hello.md'], ['src/dep.ts']]) {
      const plan = planReload({ ...input, changed })

      expect(plan).toHaveProperty('evict')
      expect((plan as { evict: string[] }).evict).toEqual(expect.arrayContaining([content, page]))
    }

    // Where no module of kay's reads it, a new process: a file beside the collections, one outside the content config's folder, or a collection with a loader.
    expect(planReload({ ...input, changed: ['src/data.json'] })).toHaveProperty('restart')
    expect(planReload({ ...input, content: undefined, changed: ['src/dep.ts'] })).toHaveProperty('restart')
    expect(planReload({ ...input, changed: ['notes/todo.md'] })).toHaveProperty('restart')
    // The config not loaded yet: nothing says what read the entry.
    expect(planReload({ ...input, loaded: [page], changed: ['src/content/posts/hello.md'] })).toHaveProperty('restart')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
