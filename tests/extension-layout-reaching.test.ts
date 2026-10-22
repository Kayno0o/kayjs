import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { routeMounts, scanRoutes } from '../src/server/routes'
import { scratchDir } from './scratch'

async function project() {
  const root = await scratchDir('layout-reaching-')
  const files: Record<string, string> = {
    'lib/_layout.kay': 'slot\n',
    'lib/widget.kay': 'p widget\n',
    'src/shared/uses.kay': '---\nimport Widget from \'../../lib/widget.kay\'\n---\nWidget\n',
    'src/shared/helper.ts': 'export { x } from \'./deep.ts\'\n',
    'src/shared/deep.ts': 'import \'./uses.kay\'\nexport const x = 1\n',
    'src/routes/plain.kay': 'p plain\n',
    'src/routes/direct.kay': '---\nimport Widget from \'../../lib/widget.kay\'\n---\nWidget\n',
    'src/routes/nested.kay': '---\nimport Uses from \'../shared/uses.kay\'\n---\nUses\n',
    'src/routes/through-script.kay': '---\nimport { x } from \'../shared/helper.ts\'\n---\np {x}\n',
    'src/routes/inner/_layout.kay': '---\nimport Widget from \'../../../lib/widget.kay\'\n---\nWidget\nslot\n',
    'src/routes/inner/page.kay': 'p page\n',
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

  expect(wrapped).toEqual(['/direct', '/inner/page', '/nested', '/through-script'])
})

test('a plain layout still wraps every page, and a linked file reaches as its real path', async () => {
  const root = await project()
  const plain = await scanRoutes(join(root, 'src/routes'), routeMounts(root, [{ name: 'lib', layout: 'lib/_layout.kay' }]))

  expect(plain.every(route => route.layouts[0]!.endsWith('lib/_layout.kay'))).toBe(true)

  await symlink(join(root, 'lib'), join(root, 'linked'))

  const linked = routeMounts(root, [{ name: 'lib', layout: { file: 'lib/_layout.kay', reaching: ['linked/widget.kay'] } }])
  const routes = await scanRoutes(join(root, 'src/routes'), linked)

  expect(routes.find(route => route.pattern === '/direct')!.layouts.length).toBe(1)
  expect(routes.find(route => route.pattern === '/plain')!.layouts.length).toBe(0)
})
