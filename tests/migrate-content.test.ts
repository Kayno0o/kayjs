import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { rewrittenSource } from '../src/content/rewrite'
import { scratchDir } from './scratch'

const CONFIG = `import { t } from 'elysia'
import { collection, convertField, renameField, setField } from 'kay/content'

const steps = [renameField('name', 'title'), convertField('price', value => typeof value === 'string' ? Number.parseInt(value, 10) : value), setField('visible', true)]
const schema = t.Object({ title: t.String(), price: t.Integer(), visible: t.Boolean() })

export const packs = collection('content/packs', { schema, migrations: steps })
export const notes = collection('content/notes', { schema, migrations: steps })
export const plain = collection('content/plain', { schema: t.Object({ title: t.String() }) })
`

async function project(): Promise<string> {
  const root = await scratchDir('migrate-content-')

  await Bun.write(join(root, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({})\n')
  await Bun.write(join(root, 'src/content.config.ts'), CONFIG)

  return root
}

async function migrate(root: string, ...args: string[]): Promise<{ out: string, err: string, code: number }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'migrate', 'content', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { out, err, code }
}

describe('rewriting an entry file', () => {
  it('keeps the format: JSON with its indentation, YAML, a Markdown body byte for byte', () => {
    expect(rewrittenSource('a.json', '{\n    "a": 1\n}\n', { b: 2 })).toBe('{\n    "b": 2\n}\n')
    expect(rewrittenSource('a.json', '{"a":1}', { b: 2 })).toBe('{\n  "b": 2\n}')
    expect(rewrittenSource('a.yaml', 'a: 1\n', { b: 2 })).toBe('b: 2\n')
    expect(rewrittenSource('a.md', '---\r\na: 1\r\n---\r\n\r\nBody  \r\n\r\n  indented\r\n', { b: 2 })).toBe('---\r\nb: 2\r\n---\r\n\r\nBody  \r\n\r\n  indented\r\n')
    expect(rewrittenSource('a.md', 'Only a body\n', { b: 2 })).toBe('---\nb: 2\n---\n\nOnly a body\n')
  })

  it('keeps a `# draft` mark and writes hostile text as data, not as structure', () => {
    expect(rewrittenSource('a.yaml', '# draft\na: 1\n', { b: 2 })).toBe('# draft\nb: 2\n')
    expect(rewrittenSource('a.md', '---\n# draft\na: 1\n---\nBody\n', { b: 2 })).toBe('---\n# draft\nb: 2\n---\nBody\n')

    const hostile = { 'title': '--- \n: # x\n"quoted" & *anchor', 'a.b': 'x: y', 'list': ['- z', ''] }

    for (const file of ['a.json', 'a.yaml', 'a.md'])
      expect(rewrittenSource(file, '', hostile)).toBeString()

    const text = rewrittenSource('a.yaml', 'a: 1\n', hostile)

    expect(Bun.YAML.parse(text)).toEqual(hostile)
    expect(Bun.YAML.parse(rewrittenSource('a.md', '---\na: 1\n---\n', hostile).slice(4, -4))).toEqual(hostile)
  })
})

describe('kay migrate content', () => {
  it('rewrites the files of the folder collections whose entries migrated, and no other', async () => {
    const root = await project()

    try {
      await Bun.write(join(root, 'src/content/packs/old.json'), '{\n    "name": "Old",\n    "price": "100 €"\n}\n')
      await Bun.write(join(root, 'src/content/packs/fine.json'), '{"title":"Fine","price":1,"visible":false}')
      await Bun.write(join(root, 'src/content/packs/odd.yaml'), '# draft\nname: Odd\nprice: "7"\n')
      await Bun.write(join(root, 'src/content/notes/hello.md'), '---\nname: Hello\nprice: "3"\n---\n\n# Body\n\nKept  as is.\n')
      await Bun.write(join(root, 'src/content/notes/hopeless.md'), '---\nprice: x\n---\nBody\n')
      await Bun.write(join(root, 'src/content/plain/a.json'), '{"name":"untouched"}')

      const { out, code } = await migrate(root)

      expect(code).toBe(0)
      expect(out).toContain('3 files rewritten')
      expect(await Bun.file(join(root, 'src/content/packs/old.json')).text()).toBe('{\n    "price": 100,\n    "title": "Old",\n    "visible": true\n}\n')
      expect(await Bun.file(join(root, 'src/content/packs/fine.json')).text()).toBe('{"title":"Fine","price":1,"visible":false}')
      expect(await Bun.file(join(root, 'src/content/packs/odd.yaml')).text()).toBe('# draft\nprice: 7\ntitle: Odd\nvisible: true\n')
      expect(await Bun.file(join(root, 'src/content/notes/hello.md')).text()).toBe('---\nprice: 3\ntitle: Hello\nvisible: true\n---\n\n# Body\n\nKept  as is.\n')
      expect(await Bun.file(join(root, 'src/content/notes/hopeless.md')).text()).toBe('---\nprice: x\n---\nBody\n')
      expect(await Bun.file(join(root, 'src/content/plain/a.json')).text()).toBe('{"name":"untouched"}')

      // Run again, nothing is left to carry over.
      expect((await migrate(root)).out).toContain('0 files rewritten')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('reports a file it cannot read and exits 1, leaving the others rewritten', async () => {
    const root = await project()

    try {
      await Bun.write(join(root, 'src/content/packs/broken.json'), '{ nope')
      await Bun.write(join(root, 'src/content/packs/old.json'), '{"name":"Old","price":"1"}')

      const { out, err, code } = await migrate(root, '--format', 'json')

      expect(code).toBe(1)
      expect(JSON.parse(out)).toMatchObject({ rewritten: ['src/content/packs/old.json'], failed: [{ file: 'src/content/packs/broken.json' }] })
      expect(err).toBe('')
      expect(await Bun.file(join(root, 'src/content/packs/old.json')).json()).toEqual({ price: 1, title: 'Old', visible: true })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('says so when no folder collection declares migrations', async () => {
    const root = await scratchDir('migrate-content-none-')

    try {
      await Bun.write(join(root, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({})\n')

      const { out, code } = await migrate(root)

      expect(code).toBe(0)
      expect(out).toContain('no folder collection declares `migrations`')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
