import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n'
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
// Two pages share a value built from a collection: neither runs its load again once the first has.
const latest = '--- server\nimport { cached } from \'kay/cache\'\nimport { news } from \'../content.config\'\n\nexport const page = { prerender: true }\n\nconst titles = await cached(\'latest\', 600, async () => (await news.all()).map(entry => entry.data.title).join())\n---\nh1 {titles}\n'
const FILES: Record<string, string> = {
  'src/data.ts': 'export const data = { value: \'one\', title: \'first\' }\n',
  'src/content.config.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\nimport { data } from \'./data\'\n\nexport const news = collection({ name: \'news\', load: () => [{ slug: \'a\', data: { title: data.title }, html: \'<p>x</p>\' }] }, { schema: s.Object({ title: s.String() }) })\n',
  'src/routes/value.kay': '--- server\nimport { cached } from \'kay/cache\'\nimport { data } from \'../data\'\n\nexport const page = { prerender: true }\n\nconst value = await cached(\'value\', 600, () => data.value)\n---\nh1 {value}\n',
  'src/routes/news.kay': '--- server\nimport { news } from \'../content.config\'\n\nexport const page = { prerender: true }\n\nconst entries = await news.all()\n---\nh1 {entries[0]!.data.title}\n',
  'src/routes/latest-a.kay': latest,
  'src/routes/latest-b.kay': latest,
  'src/routes/fn.kay': '--- server\nimport { cached } from \'kay/cache\'\nimport { data } from \'../data\'\n\nexport const page = { prerender: true }\n\nconst value = await cached(\'fn:1\', 600, () => data.value)\n---\nh1 {value}\n',
  'src/routes/plain.kay': '--- server\nimport { data } from \'../data\'\n\nexport const page = { prerender: true }\n---\nh1 {data.value}\n',
}

// Serves what the build wrote in this process, so the script can change the data and invalidate, answering each path before and after.
function SERVE(root: string) {
  return `import { Elysia } from 'elysia'
import { invalidate } from 'kay/cache'
import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}
import { data } from './src/data'
import { news } from './src/content.config'

const app = new Elysia().use(await pages({ root: ${JSON.stringify(root)}, prebuilt: true, log: false, compress: false }))
const heading = async (path: string) => ((await (await app.handle(new Request(\`http://localhost\${path}\`))).text()).match(/<h1>(.*?)<\\/h1>/)?.[1])
const seen: Record<string, (string | undefined)[]> = {}
const look = async (name: string) => { (seen[name] ??= []).push(await heading('/' + name)) }

const names = ['value', 'news', 'plain', 'latest-a', 'latest-b', 'fn']

for (const name of names)
  await look(name)

data.value = 'two'
data.title = 'second'
invalidate('value')
invalidate(key => key.startsWith('fn:'))
news.invalidate()

for (const name of names)
  await look(name)

console.log(JSON.stringify(seen))
process.exit(0)
`
}

describe('invalidating a data source refreshes the pages built from it', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('refreshes the pages that read a cached key or a collection, and none other', async () => {
    const root = await scratchDir('reads-')

    roots.push(root)
    await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': CONFIG, ...FILES, 'serve.ts': SERVE(root) }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const { code, report, output } = await kayBuild([root, '--no-check'])

    if (code !== 0)
      throw new Error(`${report}${output}`)

    const child = Bun.spawn([process.execPath, join(root, 'serve.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, served] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    if (served !== 0)
      throw new Error(`${out}${err}`)

    expect(JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)) as unknown).toEqual({ 'value': ['one', 'two'], 'news': ['first', 'second'], 'plain': ['one', 'one'], 'latest-a': ['first', 'second'], 'latest-b': ['first', 'second'], 'fn': ['one', 'two'] })
  }, 120_000)
})
