import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const CLI = resolve('src/cli.ts')

// A library's manifest, naming kay as a peer by `kay`, the name it is published as, or the one it was published as up to 0.3.
function manifest(kay: 'kay' | '@kaynooo/kayjs' | '@kaynooo/kay'): string {
  return JSON.stringify({ name: 'kay-lib', version: '1.0.0', type: 'module', peerDependencies: { [kay]: '*' }, exports: { './*.kay': './src/*.kay', '.': './src/index.ts' }, kay: { settings: './src/settings' } })
}

// A kay library as it is installed: `.kay` sources, `kay` as a peer, an exports map giving each component a specifier, and default settings the app can replace, named without their extension.
const LIBRARY: Record<string, string> = {
  'package.json': manifest('kay'),
  'src/defaults.ts': 'export interface Settings {\n  tone: string\n  icon: (name: string) => string\n}\n\nconst defaults: Settings = { tone: \'text-gray-500\', icon: name => `default:${name}` }\n\nexport default defaults\n',
  'src/settings.ts': 'export { default } from \'./defaults\'\n',
  'src/badge.kay': '---\nimport settings from \'./settings\'\n\nconst { label } = props<{ label: string }>()\n---\nspan.badge.lib-badge-class(class={settings.tone}) {label} {settings.icon(label)}\n',
  'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport settings from \'./settings\'\n\nconst { start } = props<{ start: number }>()\nconst count = signal(start)\n---\nbutton.lib-counter-class(onClick={() => count.set(c => c + 1)}) {settings.icon(\'count\')} {count()}\n',
  'src/unused.kay': '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\nbutton.lib-unused-class(onClick={() => open.set(o => !o)}) never rendered\n',
  'src/broken.kay': '---\nconst { size } = props<{ size: number }>()\n---\np {size.toUpperCase()}\n',
  'src/index.ts': 'export type { Settings } from \'./defaults\'\nexport { default as defaults } from \'./defaults\'\n',
}

const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'kay-lib': '1.0.0' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ settings: { \'kay-lib\': \'./src/ui-settings.ts\' } })\n',
  // The app extends the defaults, keeping their tone.
  'src/ui-settings.ts': 'import type { Settings } from \'kay-lib\'\nimport { defaults } from \'kay-lib\'\n\nconst settings: Settings = { ...defaults, icon: name => `app:${name}` }\n\nexport default settings\n',
  'src/routes/index.kay': '---\nimport Badge from \'kay-lib/badge.kay\'\nimport Counter from \'kay-lib/counter.kay\'\n---\nmain\n  Badge(label="hi")\n  Counter(start={2})\n',
  // A content config registers the `.kay` loader before the pages are prerendered.
  'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', { schema: t.Object({ title: t.String() }) })\n',
  'src/content/notes/first.md': '---\ntitle: First\n---\n\nHi\n',
}

const projects: string[] = []

async function write(dir: string, files: Record<string, string>) {
  await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(dir, name), text)))
}

async function run(...args: string[]): Promise<{ code: number, output: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, output: `${stdout}${stderr}` }
}

async function newProject(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, '.dom-'))

  projects.push(dir)
  await write(dir, PROJECT)
  await write(join(dir, 'node_modules/kay-lib'), LIBRARY)

  return dir
}

afterAll(async () => {
  await Promise.all(projects.map(async dir => rm(dir, { recursive: true, force: true })))
})

// Named by either published name, the current one or the one up to 0.3.
describe.each(['@kaynooo/kayjs', '@kaynooo/kay'] as const)('a linked kay library naming kay %s', (kay) => {
  let linked: string
  let library: string

  beforeAll(async () => {
    linked = await mkdtemp(join(import.meta.dir, '.dom-'))
    library = await mkdtemp(join(import.meta.dir, '.dom-'))
    await write(linked, { ...PROJECT, 'kay.config.ts': 'export default {}\n' })
    await write(library, { ...LIBRARY, 'package.json': manifest(kay) })
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
    const html = await Bun.file(join(out, 'index.html')).text()

    expect(html).toContain('<span class="badge lib-badge-class text-gray-500">hi default:hi</span>')
    // Named as an installed copy's island is, not by where the link points.
    expect(html).toContain('data-component="node_modules/kay-lib/src/counter.kay"')
    expect(built.output).toContain('built 1 island')
    expect(checked.output).toBe('')
    expect(checked.code).toBe(0)
  })
})

describe('kay libraries', () => {
  it('builds a site rendering a library\'s components with the app\'s settings, its island registered and its classes seen', async () => {
    const project = await newProject()
    const out = join(project, 'out')
    const { code, output } = await run('build', project, '--static', '--outdir', out)

    expect(code).toBe(0)
    expect(output).toContain('built 1 island')

    const html = await Bun.file(join(out, 'index.html')).text()
    const scripts = await Promise.all((await readdir(join(out, '_kay'))).filter(name => name.endsWith('.js')).map(async name => Bun.file(join(out, '_kay', name)).text()))
    const classes = (await Bun.file(join(project, '.kay/classes.txt')).text()).split('\n')

    expect(html).toContain('<span class="badge lib-badge-class text-gray-500">hi app:hi</span>')
    expect(html).toContain('data-component="node_modules/kay-lib/src/counter.kay"')
    expect(scripts.join('\n')).toContain('app:')
    expect(scripts.join('\n')).not.toContain('never rendered')
    // The default tone lives in a script of the library, not in a template.
    expect(classes).toEqual(expect.arrayContaining(['badge', 'lib-badge-class', 'lib-counter-class', 'text-gray-500']))
    expect(classes).not.toContain('lib-unused-class')
  })

  it('renders with the app\'s settings under kay test, whose preload registers the loader', async () => {
    const project = await newProject()

    await Bun.write(join(project, 'site.kay-test.ts'), `import { expect, it } from 'bun:test'\nimport { testSite } from ${JSON.stringify(resolve('src/test'))}\n\nit('renders', async () => {\n  expect((await (await testSite()).visit('/')).html).toContain('hi app:hi')\n})\n`)

    const child = Bun.spawn([process.execPath, 'test', '--preload', resolve('src/test/preload.ts'), './site.kay-test.ts'], { cwd: project, stdout: 'pipe', stderr: 'pipe' })
    const [output, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(output).toContain('1 pass')
    expect(code).toBe(0)
  })

  it('mounts a library component built for the browser with the app\'s settings, its handlers running', async () => {
    const project = await newProject()
    const test = [
      'import { GlobalRegistrator } from \'@happy-dom/global-registrator\'',
      'import { expect, it } from \'bun:test\'',
      `import { mount, settle } from ${JSON.stringify(resolve('src/test'))}`,
      '',
      'GlobalRegistrator.register()',
      '',
      'it(\'counts\', async () => {',
      '  const { root } = await mount(\'node_modules/kay-lib/src/counter.kay\', { start: 2 })',
      '',
      '  root.querySelector(\'button\')!.click()',
      '  await settle()',
      '  expect(root.textContent).toBe(\'app:count 3\')',
      '})',
      '',
    ].join('\n')

    await Bun.write(join(project, 'mount.kay-test.ts'), test)

    const child = Bun.spawn([process.execPath, 'test', './mount.kay-test.ts'], { cwd: project, stdout: 'pipe', stderr: 'pipe' })
    const [output, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(output).toContain('1 pass')
    expect(code).toBe(0)
  })

  it('renders a project nested below the working directory under kay test, named by KAY_ROOT', async () => {
    const outer = await mkdtemp(join(import.meta.dir, '.dom-'))

    projects.push(outer)
    await write(join(outer, 'fixture'), PROJECT)
    await write(join(outer, 'fixture/node_modules/kay-lib'), LIBRARY)
    // Imported before any `testSite` call, which only the preload makes possible.
    await Bun.write(join(outer, 'site.kay-test.ts'), `import { expect, it } from 'bun:test'\nimport { testSite } from ${JSON.stringify(resolve('src/test'))}\nimport Badge from './fixture/node_modules/kay-lib/src/badge.kay'\n\nit('renders', async () => {\n  expect(Badge).toBeFunction()\n  expect((await (await testSite()).visit('/')).html).toContain('hi app:hi')\n})\n`)

    const child = Bun.spawn([process.execPath, 'test', '--preload', resolve('src/test/preload.ts'), './site.kay-test.ts'], { cwd: outer, env: { ...process.env, KAY_ROOT: 'fixture' }, stdout: 'pipe', stderr: 'pipe' })
    const [output, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(output).toContain('1 pass')
    expect(code).toBe(0)
  })

  it('types a library\'s components in the app, reporting an error inside one the app uses at its own line, and the app\'s settings against the defaults', async () => {
    const project = await newProject()

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
