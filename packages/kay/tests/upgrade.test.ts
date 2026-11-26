import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { checkProject } from '../src/cli/check'
import { runCli } from '../src/cli/index'
import { upgradeProject } from '../src/cli/upgrade'

const tempDirs: string[] = []
function appWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-upgrade-'))
  tempDirs.push(dir)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}
const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('kay upgrade moves an app onto @kayjs/kay (#3591)', () => {
  it('renames the kay dependency in place and moves every @kayjs package to kay\'s version', () => {
    const dir = appWith({
      'package.json': `${JSON.stringify({ name: 'app', dependencies: { '@kayjs/ui': '^2.0.0-alpha.7', 'kay': 'npm:@kayjs/kay@^2.0.0-alpha.7', 'zod': '^3.0.0' }, devDependencies: { '@kayjs/auth': '1.0.0' } }, null, '\t')}\n`,
    })
    expect(upgradeProject(dir).changed).toEqual(['package.json'])
    expect(read(dir, 'package.json')).toBe(`${JSON.stringify({ name: 'app', dependencies: { '@kayjs/ui': `^${pkg.version}`, '@kayjs/kay': `^${pkg.version}`, 'zod': '^3.0.0' }, devDependencies: { '@kayjs/auth': `^${pkg.version}` } }, null, '\t')}\n`)
  })

  it('points jsxImportSource and @jsxImportSource pragmas at @kayjs/kay', () => {
    const dir = appWith({
      'tsconfig.json': '{\n  // kept\n  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "kay" }\n}\n',
      'src/Card.tsx': '/** @jsxImportSource kay */\nexport const Card = () => <p>card</p>\n',
    })
    upgradeProject(dir)
    expect(read(dir, 'tsconfig.json')).toBe('{\n  // kept\n  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "@kayjs/kay" }\n}\n')
    expect(read(dir, 'src/Card.tsx')).toBe('/** @jsxImportSource @kayjs/kay */\nexport const Card = () => <p>card</p>\n')
  })

  it('rewrites every import of kay, moving config names out of kay/server', () => {
    const dir = appWith({
      'kay.config.ts': [
        'import type { KayConfig } from \'kay/server\'',
        'import { action, defineConfig, type ActionContext } from \'kay/server\';',
        'import { signal } from "kay"',
        'export { raw } from \'kay/ssr\'',
        'type Locals = import(\'kay/server\').KayLocals',
        'declare module \'kay/server\' { interface KayLocals { user?: string } }',
        'import { kayFormat } from \'kayak\'',
        '',
      ].join('\n'),
    })
    expect(upgradeProject(dir)).toEqual({ changed: ['kay.config.ts'], manual: [] })
    expect(read(dir, 'kay.config.ts')).toBe([
      'import type { KayConfig } from \'@kayjs/kay/config\'',
      'import { action, type ActionContext } from \'@kayjs/kay/server\';',
      'import { defineConfig } from \'@kayjs/kay/config\';',
      'import { signal } from "@kayjs/kay"',
      'export { raw } from \'@kayjs/kay/server\'',
      'type Locals = import(\'@kayjs/kay/server\').KayLocals',
      'declare module \'@kayjs/kay/server\' { interface KayLocals { user?: string } }',
      'import { kayFormat } from \'kayak\'',
      '',
    ].join('\n'))
  })

  it('moves the icons plugin import to @kayjs/icons/plugin, leaving the component on @kayjs/icons (#3592)', () => {
    const dir = appWith({
      'kay.config.ts': 'import { icons } from \'@kayjs/icons\';\n',
      'src/Nav.tsx': 'import { Icon, icons, type IconsPluginOptions } from "@kayjs/icons"\nimport { Icon as I } from \'@kayjs/icons\'\n',
    })
    expect(upgradeProject(dir)).toEqual({ changed: ['kay.config.ts', 'src/Nav.tsx'], manual: [] })
    expect(read(dir, 'kay.config.ts')).toBe('import { icons } from \'@kayjs/icons/plugin\';\n')
    expect(read(dir, 'src/Nav.tsx')).toBe('import { Icon } from "@kayjs/icons"\nimport { icons, type IconsPluginOptions } from "@kayjs/icons/plugin"\nimport { Icon as I } from \'@kayjs/icons\'\n')
  })

  it('names each import that is no longer public, with its file and line, and leaves it as written', () => {
    const dir = appWith({
      'src/server.ts': 'import { signal } from \'kay\'\nimport { loadConfig, nodeEnv } from \'kay/server\'\nimport { mount } from \'kay/dom\'\n',
    })
    expect(upgradeProject(dir).manual).toEqual([
      'src/server.ts:2: loadConfig is not exported by @kayjs/kay/server or @kayjs/kay/config: it is kay\'s internal API, outside semver.',
      'src/server.ts:3: kay/dom has no public @kayjs/kay entry: import from @kayjs/kay, /server, /config or /test.',
    ])
    expect(read(dir, 'src/server.ts')).toBe('import { signal } from \'@kayjs/kay\'\nimport { loadConfig, nodeEnv } from \'@kayjs/kay/server\'\nimport { mount } from \'kay/dom\'\n')
  })

  it('takes an app on the bare spelling to a passing kay check', async () => {
    const dir = appWith({
      'package.json': `${JSON.stringify({ name: 'app', dependencies: { kay: 'npm:@kayjs/kay@^2.0.0-alpha.7' } }, null, 2)}\n`,
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\nexport default defineConfig({ lang: \'fr\' })\n',
      'src/actions/notes.ts': 'import { action } from \'kay/server\'\nexport const save = action(async () => ({ ok: true }))\n',
      'src/routes/index.tsx': 'import { signal } from \'kay\'\nimport { save } from \'../actions/notes\'\nfunction Counter() { const n = signal(0); return <button type="button" onClick={() => n.value++}>{n.value}</button> }\nexport default function Home() { return <main><Counter /><form action={save} method="post"><button>Save</button></form></main> }\n',
    })
    mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
    symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')

    const lines: string[] = []
    expect(await runCli(['upgrade', dir, '--no-install'], { stdout: line => lines.push(line), stderr: line => lines.push(line) })).toBe(0)
    expect(lines).toEqual(['  kay.config.ts', '  package.json', '  src/actions/notes.ts', '  src/routes/index.tsx', 'kay upgrade rewrote 4 files', 'Next: kay check'])
    expect(await checkProject(dir, { skipTypecheck: true })).toMatchObject({ ok: true, errors: [] })
  })

  it('leaves node_modules, dist, nested packages and an app already on @kayjs/kay untouched', () => {
    const dir = appWith({
      'starters/v1/package.json': '{}\n',
      'starters/v1/src/index.ts': 'import { signal } from \'kay\'\n',
      'node_modules/lib/index.ts': 'import { signal } from \'kay\'\n',
      'dist/types/index.ts': 'import { signal } from \'kay\'\n',
      '.cache/kay/index.ts': 'import { signal } from \'kay\'\n',
      'src/index.ts': 'import { signal } from \'@kayjs/kay\'\n',
    })
    expect(upgradeProject(dir)).toEqual({ changed: [], manual: [] })
    expect(read(dir, 'node_modules/lib/index.ts')).toBe('import { signal } from \'kay\'\n')
  })
})
