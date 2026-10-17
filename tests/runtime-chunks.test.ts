import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { directImports } from '../src/build/direct-imports'
import { kayPlugin } from '../src/build/plugin'
import { fixtureCopy, scratchDir } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

// The error ActionError builds its message from, which only the chunk holding the action runtime carries.
const ACTION_RUNTIME = 'Action failed with'

async function chunkText(client: Awaited<ReturnType<typeof buildClient>>, url: string): Promise<string> {
  return Bun.file(join(client.dir, url.slice('/_kay/'.length))).text()
}

describe('the runtime modules a page loads', () => {
  it('are those its own islands use: the page of an island without ActionError loads no action code, the one using it does', async () => {
    const root = resolve(await fixtureCopy('runtime-chunks'))

    dirs.push(root)
    const client = await buildClient(root)
    const plain = client.islands['src/components/plain-one.kay']!
    const failing = client.islands['src/components/failing.kay']!
    const loaded = async (chunks: string[]) => (await Promise.all(chunks.map(async chunk => chunkText(client, chunk)))).join('\n')

    expect(await loaded(plain)).not.toContain(ACTION_RUNTIME)
    expect(await loaded(failing)).toContain(ACTION_RUNTIME)
    expect(await chunkText(client, client.entry!)).not.toContain(ACTION_RUNTIME)
    // The names every island shares stay in the one runtime chunk: an island's chunks are its own and that.
    expect(plain).toHaveLength(2)
    expect(failing.length).toBeGreaterThanOrEqual(2)
  }, 120_000)
})

describe('a runtime module half of the islands use', () => {
  // A copy of the fixture, whose four plain islands and one failing one get `extra` more failing ones.
  async function build(extra: number): Promise<Awaited<ReturnType<typeof buildClient>>> {
    const root = resolve(await fixtureCopy('runtime-chunks'))

    dirs.push(root)
    const failing = await Bun.file(join(root, 'src/components/failing.kay')).text()
    const names = ['two', 'three', 'four', 'five'].slice(0, extra)

    await Promise.all(names.map(async name => Bun.write(join(root, `src/components/failing-${name}.kay`), failing)))
    await Bun.write(join(root, 'src/routes/many.kay'), `--- script\n${names.map(name => `import Failing${name} from '../components/failing-${name}.kay'`).join('\n')}\n---\nh1 Many\n${names.map(name => `Failing${name}`).join('\n')}\n`)

    return buildClient(root)
  }

  it('stays in the runtime chunk every page loads at half of the islands, and a small app keeps its one runtime chunk', async () => {
    // Four of eight islands.
    const client = await build(3)

    expect(await chunkText(client, client.entry!)).toContain(ACTION_RUNTIME)
    expect(client.islands['src/components/plain-one.kay']).toHaveLength(2)
    expect(Object.values(client.islands).filter(chunks => chunks.length !== 2 || chunks[1] !== client.entry)).toEqual([])
  }, 120_000)

  it('stays with its islands below half of them', async () => {
    // Three of seven islands.
    const client = await build(2)

    expect(await chunkText(client, client.entry!)).not.toContain(ACTION_RUNTIME)
    expect(client.islands['src/components/failing.kay']!.length).toBeGreaterThan(2)
  }, 120_000)
})

describe('direct imports of the runtime', () => {
  it('point each name of `kay` at the module holding it, keep an alias, and drop what is only a type', async () => {
    const code = await directImports('import { ActionError, signal, type Signal, effect as run } from \'kay\'\nimport { registerImage } from "kay/internal"\nimport { template } from \'kay/dom\'\nimport * as all from \'kay\'\n')
    const lines = code.split('\n')

    expect(lines[0]).toMatch(/^import \{ ActionError \} from ".*\/runtime\/action\.ts"; import \{ signal \} from ".*\/runtime\/core\.ts"; import \{ effect as run \} from ".*\/runtime\/reactive\.ts";$/)
    expect(lines[0]).not.toContain('Signal')
    expect(lines[1]).toMatch(/^import \{ registerImage \} from ".*\/runtime\/image\.ts";$/)
    // Not a barrel, and a namespace import takes the whole module.
    expect(lines.slice(2)).toEqual(['import { template } from \'kay/dom\'', 'import * as all from \'kay\'', ''])
  })

  it('keeps the lines of a statement, leaves import text in a string or a template literal alone, and an import with attributes', async () => {
    const multiline = await directImports('import {\n  signal,\n  effect,\n} from \'kay\'\nconst after = 1\n')

    expect(multiline.split('\n').length).toBe(6)
    expect(multiline.split('\n')[4]).toBe('const after = 1')

    const quoted = 'const sample = "import { signal } from \'kay\'"\n'

    expect(await directImports(quoted)).toBe(quoted)

    const templated = 'import { signal } from \'kay\'\nconst sample = `\nimport { effect } from \'kay\'\n`\n'

    expect(await directImports(templated)).toBe(templated)

    const attributes = 'import { signal } from \'kay\' with { type: \'js\' }\n'

    expect(await directImports(attributes)).toBe(attributes)
  })

  it('leaves a file alone whose import text in a template literal or a comment hides behind a namespace, default or side-effect import of the barrel', async () => {
    const namespace = 'import * as k from \'kay\'\nimport { signal } from \'kay\'\nconst sample = `\nimport { effect } from \'kay\'\n`\n'
    const imported = 'import kay from \'kay\'\nconst sample = `\nimport { effect } from \'kay\'\n`\n'
    const effectOnly = 'import \'kay\'\nconst sample = `\nimport { effect } from \'kay\'\n`\n'
    const commented = 'import * as k from \'kay\'\n/*\nimport { effect } from \'kay\'\n*/\n'
    const typedText = 'import { signal } from \'kay\'\nconst sample = `\nimport { type X } from \'kay\'\nimport {} from \'kay\'\n`\n'

    expect(await directImports(typedText)).toContain('`\nimport { type X } from \'kay\'\nimport {} from \'kay\'\n`')

    const typed = 'import type { Signal } from \'kay\'\nimport type { Effect } from \'kay\'\nconst sample = `\nimport { effect } from \'kay\'\n`\n'

    for (const source of [namespace, imported, effectOnly, commented, typed])
      expect(await directImports(source)).toBe(source)
  })

  it('still rewrites a named import beside a namespace import of the barrel, keeping the line count', async () => {
    const source = 'import * as k from \'kay\'\nimport {\n  signal,\n} from \'kay\'\nconst after = k\n'
    const code = await directImports(source)

    expect(code).toContain('/runtime/core.ts')
    expect(code.split('\n').length).toBe(source.split('\n').length)
    expect(code.split('\n')[4]).toBe('const after = k')
  })

  it('leaves a name the barrel does not export in an import of the barrel', async () => {
    expect(await directImports('import { nothing } from \'kay\'')).toBe('import { nothing } from \'kay\';')
  })

  it('rewrites a project module and leaves a module under node_modules importing the barrel', async () => {
    const root = await scratchDir('direct-node-modules-')

    dirs.push(root)
    await Bun.write(join(root, 'src/own.ts'), 'import { signal } from \'kay\'\nexport const own = signal\n')
    await Bun.write(join(root, 'src/both.ts'), 'import { own } from \'./own\'\nimport { vendored } from \'vendored\'\nexport { own, vendored }\n')
    await Bun.write(join(root, 'node_modules/vendored/package.json'), '{"name":"vendored","main":"index.ts"}')
    await Bun.write(join(root, 'node_modules/vendored/index.ts'), 'import { effect } from \'kay\'\nexport const vendored = effect\n')

    const bundled = async (entry: string) => {
      const build = await Bun.build({ entrypoints: [join(root, entry)], target: 'bun', plugins: [kayPlugin({ root, direct: true }, [])] })

      expect(build.success).toBe(true)

      return build.outputs[0]!.text()
    }

    // The runtime's own barrel is in a bundle only when some module imports it as it is.
    expect(await bundled('src/own.ts')).not.toContain('src/runtime/index.ts')
    expect(await bundled('src/both.ts')).toContain('src/runtime/index.ts')
  })
})
