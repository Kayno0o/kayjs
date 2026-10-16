import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/site\', i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } })\n'
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const FILES: Record<string, string> = {
  'src/messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n',
  'src/messages/fr.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n',
  'src/data.ts': 'export const data = { value: \'one\', renders: 0 }\n',
  'src/content.config.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', { schema: s.Object({ title: s.String() }) })\n',
  'src/content/notes/a.md': '---\ntitle: first\n---\nbody\n',
  'src/routes/notes.kay': '--- server\nimport { notes } from \'../content.config\'\nimport { data } from \'../data\'\n\nexport const page = { prerender: true }\n\nconst entries = await notes.all()\nconst renders = data.renders++\n---\nh1 {entries[0]!.data.title}:{renders}\n',
  // The value is read while the body streams, after the fence returned.
  'src/routes/stream.kay': '--- server\nimport { cached } from \'kay/cache\'\nimport { data } from \'../data\'\n\nexport const page = { prerender: true }\n\nconst late = cached(\'late\', 600, async () => data.value)\n---\nawait late\n  p Loading\nthen value\n  p.val {value}\n',
}

// Serves what the build wrote, answering each path (a proxy takes the base off before it arrives) in each locale before and after the invalidations.
function SERVE(root: string) {
  return `import { Elysia } from 'elysia'
import { invalidate } from 'kay/cache'
import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}
import { data } from './src/data'
import { notes } from './src/content.config'

const app = new Elysia().use(await pages({ root: ${JSON.stringify(root)}, prebuilt: true, base: '/site', log: false, compress: false }))
const text = async (path: string) => ((await (await app.handle(new Request(\`http://localhost\${path}\`))).text()).match(/<(?:h1|p class="val")>(.*?)<\\/(?:h1|p)>/)?.[1])
const seen: Record<string, (string | undefined)[]> = {}
const paths = ['/notes', '/fr/notes', '/stream', '/fr/stream']
const look = async () => { for (const path of paths) (seen[path] ??= []).push(await text(path)) }

// The build rendered each page counting from 0; a render here counts from 100.
data.renders = 100
await look()
data.value = 'two'
invalidate('late')
notes.invalidate()
await look()
console.log(JSON.stringify(seen))
process.exit(0)
`
}

describe('invalidating refreshes the pages of a site under a base and locales', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('refreshes a folder collection and a streamed value, in each locale', async () => {
    const root = await scratchDir('reads-site-')

    roots.push(root)
    await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': CONFIG, ...FILES, 'serve.ts': SERVE(root) }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const build = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [built, builtErr, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])

    if (code !== 0)
      throw new Error(`${built}${builtErr}`)

    const child = Bun.spawn([process.execPath, join(root, 'serve.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, served] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    if (served !== 0)
      throw new Error(`${out}${err}`)

    expect(JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)) as unknown).toEqual({
      // Production serves the entries compiled by the build, so what shows a refresh is the render that ran again, counting from the serving process.
      '/notes': ['first:0', 'first:100'],
      '/fr/notes': ['first:1', 'first:101'],
      '/stream': ['one', 'two'],
      '/fr/stream': ['one', 'two'],
    })
  }, 120_000)
})
