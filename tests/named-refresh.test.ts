import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { forgetNamedRefresh, namedRefresh } from '../src/build/named-refresh'
import { transformKayCached } from '../src/build/transform'
import { scratchDir } from './scratch'

const PAGE = '--- server\nconst cart = await Promise.resolve({ n: 1 })\n---\nmain\n  p.cart {cart.n}\n'

const roots: string[] = []

interface Project {
  root: string
  page: string
}

async function project(routes: string, sources: Record<string, string> = {}): Promise<Project> {
  const root = await scratchDir('named-refresh-')

  roots.push(root)
  await mkdir(join(root, routes), { recursive: true })
  await Bun.write(join(root, routes, 'index.kay'), PAGE)

  for (const [file, text] of Object.entries(sources)) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await Bun.write(join(root, file), text)
  }

  return { root, page: join(root, routes, 'index.kay') }
}

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('the scan for refreshes by name', () => {
  it('finds a name given to a call, a list of names and a refresh() call', async () => {
    for (const source of ['await add({}, { refresh: \'cart\' })', 'await add({}, { refresh: [\n  \'cart\',\n] })', 'await add({}, { refresh: [list, \'cart\'] })', 'refresh("cart")']) {
      forgetNamedRefresh()

      const { page, root } = await project('src/routes', { 'src/components/button.ts': source })

      expect(namedRefresh(page, root)).toBe(true)
    }
  })

  it('finds nothing in a project naming no load', async () => {
    forgetNamedRefresh()

    const { page, root } = await project('src/routes', { 'src/components/button.ts': 'await add({}, { refresh: false, onSuccess: () => toast(\'saved\') })\nawait add({}, { refresh: cart })\nrefresh()' })

    expect(namedRefresh(page, root)).toBe(false)
  })

  it('scans the project for a routes directory outside src, and nothing above it', async () => {
    forgetNamedRefresh()

    const inside = await project('app/routes', { 'app/lib/save.ts': 'refresh(\'cart\')' })
    const nested = await project('src/routes', { 'tools/save.ts': 'refresh(\'cart\')' })

    expect(namedRefresh(inside.page, inside.root)).toBe(true)
    // `src` is the project's sources: a script beside it is not read.
    expect(namedRefresh(nested.page, nested.root)).toBe(false)
  })

  it('leaves out node_modules and a file that is no page of the project', async () => {
    forgetNamedRefresh()

    const { page, root } = await project('src/routes', { 'src/node_modules/lib/index.ts': 'refresh(\'cart\')' })

    expect(namedRefresh(page, root)).toBe(false)
    expect(namedRefresh(join(root, '..', 'index.kay'), root)).toBe(false)
  })

  it('marks the pages of a project naming a load and no other, through the build cache', async () => {
    forgetNamedRefresh()

    const quiet = await project('src/routes')
    const naming = await project('src/routes', { 'src/save.ts': 'refresh(\'cart\')' })
    const compile = async (p: Project) => transformKayCached(PAGE, p.page, { target: 'ssr', root: p.root, cacheDir: join(p.root, '.kay-cache') })

    expect(await compile(quiet)).not.toContain('data-kay-u')
    expect(await compile(naming)).toContain('data-kay-u')

    // The same file compiled again once the project names a load is not served from the entry made before.
    await Bun.write(join(quiet.root, 'src/save.ts'), 'refresh(\'cart\')')
    forgetNamedRefresh()

    expect(await compile(quiet)).toContain('data-kay-u')
  })
})
