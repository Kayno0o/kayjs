import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { directImports } from '../src/build/direct-imports'
import { fixtureCopy } from './scratch'

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
  it('stays in the runtime chunk every page loads, and a small app keeps its one runtime chunk', async () => {
    const root = resolve(await fixtureCopy('runtime-chunks'))

    dirs.push(root)
    const failing = await Bun.file(join(root, 'src/components/failing.kay')).text()
    const names = ['two', 'three', 'four', 'five']

    await Promise.all(names.map(async name => Bun.write(join(root, `src/components/failing-${name}.kay`), failing)))
    await Bun.write(join(root, 'src/routes/many.kay'), `--- script\n${names.map(name => `import Failing${name} from '../components/failing-${name}.kay'`).join('\n')}\n---\nh1 Many\n${names.map(name => `Failing${name}`).join('\n')}\n`)

    const client = await buildClient(root)
    const plain = client.islands['src/components/plain-one.kay']!

    expect(await chunkText(client, client.entry!)).toContain(ACTION_RUNTIME)
    expect(plain).toHaveLength(2)
    expect(Object.values(client.islands).filter(chunks => chunks.length !== 2 || chunks[1] !== client.entry)).toEqual([])
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

  it('leaves a name the barrel does not export in an import of the barrel', async () => {
    expect(await directImports('import { nothing } from \'kay\'')).toBe('import { nothing } from \'kay\';')
  })
})
