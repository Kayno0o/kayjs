import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const CLI = resolve('src/cli.ts')

// A kay library as it is installed: `.kay` sources, `kay` as a peer, an exports map giving each component a specifier, and default settings the app can replace.
const LIBRARY: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'kay-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay', '.': './src/index.ts', './settings': './src/settings.ts' }, kay: { settings: './src/settings.ts' } }),
  'src/settings.ts': 'export interface Settings {\n  tone: string\n  icon: (name: string) => string\n}\n\nconst settings: Settings = { tone: \'text-gray-500\', icon: name => `default:${name}` }\n\nexport default settings\n',
  'src/badge.kay': '---\nimport settings from \'./settings\'\n\nconst { label } = props<{ label: string }>()\n---\nspan.badge.lib-badge-class(class={settings.tone}) {label} {settings.icon(label)}\n',
  'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport settings from \'./settings\'\n\nconst { start } = props<{ start: number }>()\nconst count = signal(start)\n---\nbutton.lib-counter-class(onClick={() => count.set(c => c + 1)}) {settings.icon(\'count\')} {count()}\n',
  'src/unused.kay': '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\nbutton.lib-unused-class(onClick={() => open.set(o => !o)}) never rendered\n',
  'src/broken.kay': '---\nconst { size } = props<{ size: number }>()\n---\np {size.toUpperCase()}\n',
  'src/index.ts': 'export type { Settings } from \'./settings\'\n',
}

const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'kay-lib': '1.0.0' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ settings: { \'kay-lib\': \'./src/ui-settings.ts\' } })\n',
  'src/ui-settings.ts': 'import type { Settings } from \'kay-lib\'\n\nconst settings: Settings = { tone: \'text-red-500\', icon: name => `app:${name}` }\n\nexport default settings\n',
  'src/routes/index.kay': '---\nimport Badge from \'kay-lib/badge.kay\'\nimport Counter from \'kay-lib/counter.kay\'\n---\nmain\n  Badge(label="hi")\n  Counter(start={2})\n',
}

let project: string

async function write(dir: string, files: Record<string, string>) {
  await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(dir, name), text)))
}

async function run(...args: string[]): Promise<{ code: number, output: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, output: `${stdout}${stderr}` }
}

beforeAll(async () => {
  project = await mkdtemp(join(import.meta.dir, '.dom-'))
  await write(project, PROJECT)
  await write(join(project, 'node_modules/kay-lib'), LIBRARY)
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

describe('a linked kay library', () => {
  let linked: string
  let library: string

  beforeAll(async () => {
    linked = await mkdtemp(join(import.meta.dir, '.dom-'))
    library = await mkdtemp(join(import.meta.dir, '.dom-'))
    await write(linked, { ...PROJECT, 'kay.config.ts': 'export default {}\n' })
    await write(library, LIBRARY)
    await Bun.write(join(linked, 'node_modules/.keep'), '')
    await symlink(library, join(linked, 'node_modules/kay-lib'))
  })

  afterAll(async () => {
    await Promise.all([rm(linked, { recursive: true, force: true }), rm(library, { recursive: true, force: true })])
  })

  it('builds and checks as an installed one does', async () => {
    const out = join(linked, 'out')
    const built = await run('build', linked, '--static', '--outdir', out)
    const checked = await run('check', linked)

    expect(built.code).toBe(0)
    expect(await Bun.file(join(out, 'index.html')).text()).toContain('<span class="badge lib-badge-class text-gray-500">hi default:hi</span>')
    expect(built.output).toContain('built 1 island')
    expect(checked.output).toBe('')
    expect(checked.code).toBe(0)
  })
})

describe('kay libraries', () => {
  it('builds a site rendering a library\'s components, its island registered and its classes seen', async () => {
    const out = join(project, 'out')
    const { code, output } = await run('build', project, '--static', '--outdir', out)

    expect(code).toBe(0)
    expect(output).toContain('built 1 island')

    const html = await Bun.file(join(out, 'index.html')).text()
    const scripts = await Promise.all((await readdir(join(out, '_kay'))).filter(name => name.endsWith('.js')).map(async name => Bun.file(join(out, '_kay', name)).text()))
    const classes = (await Bun.file(join(project, '.kay/classes.txt')).text()).split('\n')

    expect(html).toContain('<span class="badge lib-badge-class text-red-500">hi app:hi</span>')
    expect(html).toContain('data-component="node_modules/kay-lib/src/counter.kay"')
    expect(scripts.join('\n')).toContain('app:')
    expect(scripts.join('\n')).not.toContain('`default:')
    expect(scripts.join('\n')).not.toContain('never rendered')
    expect(classes).toEqual(expect.arrayContaining(['badge', 'lib-badge-class', 'lib-counter-class']))
    expect(classes).not.toContain('lib-unused-class')
  })

  it('types a library\'s components in the app, reporting an error inside one the app uses at its own line, and the app\'s settings against the defaults', async () => {
    await write(project, {
      'src/routes/typed.kay': '---\nimport Badge from \'kay-lib/badge.kay\'\nimport Typo from \'kay-lib/typo.kay\'\n---\nBadge(label={1})\nTypo(size={2})\n',
      'src/ui-settings.ts': 'const settings = { tone: 1, icon: (name: string) => name }\n\nexport default settings\n',
    })
    await write(join(project, 'node_modules/kay-lib'), { 'src/typo.kay': '---\nconst { size } = props<{ size: number }>()\n---\np {size.toFixed(1).missing}\n' })

    const { code, output } = await run('check', project)

    expect(code).toBe(1)

    const errors = output.split('\n').filter(line => line.includes(' - error '))

    expect(errors).toEqual([
      `${relative(process.cwd(), join(project, 'src/ui-settings.ts'))}:1:1 - error TS2322: The settings for kay-lib do not match what it takes: Type '{ tone: number; icon: (name: string) => string; }' is not assignable to type 'Settings'.`,
      `${relative(process.cwd(), join(project, 'node_modules/kay-lib/src/typo.kay'))}:4:20 - error TS2339: Property 'missing' does not exist on type 'string'.`,
      `${relative(process.cwd(), join(project, 'src/routes/typed.kay'))}:5:7 - error TS2322: Type 'number' is not assignable to type 'string'.`,
    ])
  })
})
