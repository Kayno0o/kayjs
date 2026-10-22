import type { ClientBuild } from '../src/server/client'
import type { Route } from '../src/server/routes'
import { realpathSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { projectImportGraph } from '../src/build/libraries'
import { routeSizes } from '../src/build/route-sizes'
import { routeMounts, routeTrees, scanRoutes, specialPagesOf } from '../src/server/routes'
import { scratchDir } from './scratch'

async function project() {
  const root = await scratchDir('layout-reaching-')
  const files: Record<string, string> = {
    'lib/_layout.kay': 'slot\n',
    'lib/widget.kay': 'p widget\n',
    'src/shared/uses.kay': '---\nimport Widget from \'../../lib/widget.kay\'\n---\nWidget\n',
    'src/shared/helper.ts': 'export { x } from \'./deep.ts\'\n',
    'src/shared/deep.ts': 'import \'./uses.kay\'\nexport const x = 1\n',
    'src/shared/prose.kay': '---\n// moved from \'old-place\'\nimport Widget from \'../../lib/widget.kay\'\n---\np Sent from \'Bob\'\nWidget\n',
    'src/routes/hostile.kay': '---\nimport Prose from \'../shared/prose.kay\'\n---\nProse\n',
    'src/routes/off.kay': '--- server\nexport const page = { layouts: false }\n---\n---\nimport Widget from \'../../lib/widget.kay\'\n---\nWidget\n',
    'src/routes/_404.kay': '---\nimport Widget from \'../../lib/widget.kay\'\n---\nWidget\n',
    'src/routes/plain.kay': 'p plain\n',
    'src/routes/direct.kay': '---\nimport Widget from \'../../lib/widget.kay\'\n---\nWidget\n',
    'src/routes/nested.kay': '---\nimport Uses from \'../shared/uses.kay\'\n---\nUses\n',
    'src/routes/through-script.kay': '---\nimport { x } from \'../shared/helper.ts\'\n---\np {x}\n',
    'src/routes/inner/_layout.kay': '---\nimport Widget from \'../../../lib/widget.kay\'\n---\nWidget\nslot\n',
    'src/routes/inner/page.kay': 'p page\n',
    'src/routes/dynamic.kay': '---\nconst lazy = () => import("../../lib/widget.kay")\n---\np {String(lazy)}\n',
    'src/routes/aliased.kay': '---\nimport Widget from "@lib/widget.kay"\n---\nWidget\n',
    'src/routes/globbed.kay': '---\nconst all = import.meta.glob("../../lib/*.kay")\n---\np {Object.keys(all).length}\n',
    'src/routes/vendored.kay': '---\nimport Box from "vendor/box.kay"\n---\nBox\n',
    'src/routes/commented.kay': '---\n// import Widget from "../../lib/widget.kay"\nconst note = "from \'../../lib/widget.kay\'"\n---\np {note}\n',
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } } }',
    'package.json': '{ "name": "app", "dependencies": { "vendor": "*" } }',
    'node_modules/vendor/package.json': '{ "name": "vendor", "version": "1.0.0", "peerDependencies": { "kay": "*" } }',
    'node_modules/vendor/box.kay': '---\nimport Widget from "../../lib/widget.kay"\n---\nWidget\n',
  }

  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await Bun.write(join(root, path), text)
  }

  return root
}

test('a layout with `reaching` wraps the pages whose imports reach one of its files, however deep, and no other', async () => {
  const root = await project()
  const mounts = routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: ['lib/widget.kay'] } }])
  const routes = await scanRoutes(join(root, 'src/routes'), mounts)
  const wrapped = routes.filter(route => route.layouts.some(layout => layout.endsWith('lib/_layout.kay'))).map(route => route.pattern).sort()

  expect(wrapped).toEqual(['/aliased', '/direct', '/dynamic', '/globbed', '/hostile', '/inner/page', '/nested', '/through-script', '/vendored'])
})

test('a plain layout still wraps every page, and a linked file reaches as its real path', async () => {
  const root = await project()
  const plain = await scanRoutes(join(root, 'src/routes'), routeMounts(root, [{ name: 'lib', layout: 'lib/_layout.kay' }]))

  expect(plain.filter(route => route.pattern !== '/off').every(route => route.layouts[0]!.endsWith('lib/_layout.kay'))).toBe(true)

  await symlink(join(root, 'lib'), join(root, 'linked'))

  const linked = routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: ['linked/widget.kay'] } }])
  const routes = await scanRoutes(join(root, 'src/routes'), linked)

  expect(routes.find(route => route.pattern === '/direct')!.layouts.length).toBe(1)
  expect(routes.find(route => route.pattern === '/plain')!.layouts.length).toBe(0)
})

test('a special page reaching the files is wrapped, a page setting layouts: false is not, and a file that does not exist is refused', async () => {
  const root = await project()
  const mounts = routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: ['lib/widget.kay'] } }])
  const routes = await scanRoutes(join(root, 'src/routes'), mounts)

  expect(routes.find(route => route.pattern === '/off')!.layouts).toEqual([])
  expect(routes.find(route => route.pattern === '/plain')!.special.notFound!.layouts.length).toBe(1)
  expect(() => routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: ['lib/missing.kay'] } }])).toThrow('does not exist')
})

test('the special pages of a root answer with no scan of the routes before, a glob in their imports included', async () => {
  const root = await project()
  const routes = join(root, 'src/routes')
  const mounts = routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: ['lib/widget.kay'] } }])
  const first = await specialPagesOf(routeTrees(routes, mounts), '')

  // A scan opens the reach afresh, and the special pages looked up after it use that one.
  await scanRoutes(routes, mounts)

  expect(first.notFound!.layouts).toHaveLength(1)
  expect((await specialPagesOf(routeTrees(routes, mounts), '')).notFound!.layouts).toHaveLength(1)
})

test('an executable names the layout and reaching files of a bundled library without finding them on disk', async () => {
  const root = await project()
  const layout = { file: '/$bunfs/root/../viewer-layout/_layout.kay', reaching: ['/$bunfs/root/../components/signed-in.kay'] }

  expect(() => routeMounts(root, [{ name: 'lib', layout }])).toThrow('not an existing _layout.kay')
  expect(routeMounts(root, [{ name: 'lib', layout }], false)).toHaveLength(1)
})

test('an import.meta.glob pattern of a library script expands against the project root, negated patterns included', async () => {
  const root = await project()
  const files: Record<string, string> = {
    'lib/package.json': '{ "name": "lib-with-glob" }\n',
    'lib/other.kay': 'p other\n',
    'lib/parts.ts': 'export const parts = import.meta.glob([\'/src/parts/*.kay\', \'!/src/parts/draft.kay\'], { eager: true })\n',
    'src/parts/ready.kay': '---\nimport Widget from \'../../lib/widget.kay\'\n---\nWidget\n',
    'src/parts/draft.kay': '---\nimport Other from \'../../lib/other.kay\'\n---\nOther\n',
    'src/routes/_404.kay': '---\nimport { parts } from \'../../lib/parts.ts\'\n---\np {Object.keys(parts).length}\n',
    'src/routes/globbed.kay': '---\nimport { parts } from \'../../lib/parts.ts\'\n---\np {Object.keys(parts).length}\n',
  }

  for (const [path, text] of Object.entries(files))
    await Bun.write(join(root, path), text)

  const mountsReaching = (target: string) => routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: [target] } }])
  const wrapping = async (target: string) => (await scanRoutes(join(root, 'src/routes'), mountsReaching(target))).filter(route => route.layouts.length > 0).map(route => route.pattern)
  const fallback = async (target: string) => (await specialPagesOf(routeTrees(join(root, 'src/routes'), mountsReaching(target)), '')).notFound!.layouts.length

  expect(await wrapping('lib/widget.kay')).toContain('/globbed')
  expect(await wrapping('lib/other.kay')).not.toContain('/globbed')
  expect(await fallback('lib/widget.kay')).toBe(1)
  expect(await fallback('lib/other.kay')).toBe(0)
})

test('the scan and the route sizes read one import graph per project root, and the sizes follow a glob as the scan does', async () => {
  const root = await project()

  await scanRoutes(join(root, 'src/routes'), routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: ['lib/widget.kay'] } }]))

  const graph = projectImportGraph(root)

  expect(projectImportGraph(root)).toBe(graph)
  expect(graph.has(realpathSync(join(root, 'src/routes/direct.kay')))).toBe(true)

  await Bun.write(join(root, 'src/island.kay'), 'p island\n')
  await Bun.write(join(root, 'src/routes/island-glob.kay'), '---\nconst all = import.meta.glob("../island.kay")\n---\np {Object.keys(all).length}\n')
  await Bun.write(join(root, 'out/island.js'), 'export const island = 1\n')

  const report = { islands: [{ file: 'src/island.kay', size: { raw: 0, gzip: 0 }, chunks: ['/_kay/island.js'] }] }
  const route = { pattern: '/island-glob', file: join(root, 'src/routes/island-glob.kay'), params: [], layouts: [] } as unknown as Route
  const [size] = await routeSizes(root, { dir: join(root, 'out'), styles: new Map() } as unknown as ClientBuild, [route], [], report)

  expect(size!.islands).toEqual(['src/island.kay'])
  expect(projectImportGraph(root).has(realpathSync(join(root, 'src/island.kay')))).toBe(true)
})
