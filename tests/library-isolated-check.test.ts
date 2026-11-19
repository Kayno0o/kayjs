import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { kayCheck } from './check-helper'
import { kayTypes } from './kay-types'
import { scratchDir } from './scratch'

const TIMEOUT = 120_000
const projects: string[] = []

// An app listing `isolib` alone, laid out as bun's isolated install does: the app's `node_modules/isolib` links to the package inside `node_modules/.bun/isolib@1.0.0/node_modules`, where the package's own dependencies sit beside it.
async function project(component: string): Promise<string> {
  const root = await scratchDir('library-isolated-check-')

  projects.push(root)

  const store = 'node_modules/.bun/isolib@1.0.0/node_modules'

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { isolib: '*' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, paths: kayTypes() }, include: ['src', '.kay/types'] }),
    'kay.config.ts': 'export default {}\n',
    'src/routes/index.kay': '---\nimport Chip from \'isolib/chip.kay\'\n---\nChip()\n',
    [join(store, 'isolib/package.json')]: JSON.stringify({ name: 'isolib', version: '1.0.0', dependencies: { 'isolib-dep': '1.0.0' }, peerDependencies: { kay: '*' }, kay: {}, exports: { './chip.kay': './chip.kay' } }),
    [join(store, 'isolib/chip.kay')]: component,
    [join(store, 'isolib-dep/package.json')]: JSON.stringify({ name: 'isolib-dep', version: '1.0.0', types: './index.d.ts', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
    [join(store, 'isolib-dep/index.d.ts')]: 'export declare function shout(text: string): string\n',
  }

  await Promise.all(Object.entries(files).map(async ([path, text]) => Bun.write(join(root, path), text)))
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(root, store, 'isolib'), join(root, 'node_modules/isolib'))

  return root
}

afterAll(async () => {
  await Promise.all(projects.map(async dir => rm(dir, { recursive: true, force: true })))
})

const CLEAN = /checked with no problems in \d+ ms/
const CHIP = '---\nimport { shout } from \'isolib-dep\'\n---\nspan {shout(\'hi\')}\n'

describe('a library component importing its own dependency', () => {
  it('is checked in an app that does not list the dependency, under an isolated install', async () => {
    const { code, output, report } = await kayCheck([await project(CHIP)])

    expect(`${report}${output}`.slice(0, 600)).toMatch(CLEAN)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('still fails for a package nothing installs', async () => {
    const { code, report, output } = await kayCheck([await project(CHIP.replace('isolib-dep', 'isolib-missing'))])

    expect(`${report}${output}`).toContain('isolib-missing')
    expect(code).not.toBe(0)
  }, TIMEOUT)
})
