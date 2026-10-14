import { readdir, rm, symlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { findKayLibraries } from '../src/build/libraries'
import { throughLinks } from '../src/build/links'
import { projectPaths } from '../src/project'
import { scratchDir } from './scratch'

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

// Each error kay check printed, as its location then its heading.
function reported(output: string): string[] {
  const lines = output.split('\n')

  return lines.flatMap((line, index) => line.startsWith('error') ? [`${lines.slice(index).find(next => next.trimStart().startsWith('--> '))!.trim().slice('--> '.length)} ${line}`] : [])
}

async function newProject(): Promise<string> {
  const dir = await scratchDir('dom-')

  projects.push(dir)
  await write(dir, PROJECT)
  await write(join(dir, 'node_modules/kay-lib'), LIBRARY)

  return dir
}

afterAll(async () => {
  await Promise.all(projects.map(async dir => rm(dir, { recursive: true, force: true })))
})

// A library naming kay by any of its published names is found, whichever the manifest says.
describe('the names a kay library names kay by', () => {
  it('finds a library whose peer is kay, the name it is published as, or the one it was published as up to 0.3', async () => {
    const app = await scratchDir('dom-')
    const names = { 'lib-alias': 'kay', 'lib-current': '@kaynooo/kayjs', 'lib-old': '@kaynooo/kay' } as const

    projects.push(app)
    await write(app, { 'package.json': JSON.stringify({ name: 'app', private: true, dependencies: Object.fromEntries(Object.keys(names).map(name => [name, '1.0.0'])) }) })
    await Promise.all(Object.entries(names).map(async ([name, kay]) => write(join(app, 'node_modules', name), { 'package.json': manifest(kay).replace('kay-lib', name), 'src/badge.kay': LIBRARY['src/badge.kay']! })))
    await write(join(app, 'node_modules/lib-none'), { 'package.json': JSON.stringify({ name: 'lib-none', version: '1.0.0', type: 'module' }), 'src/badge.kay': 'p none\n' })

    expect((await findKayLibraries(app)).map(library => library.name).sort()).toEqual(['lib-alias', 'lib-current', 'lib-old'])
  })
})

// Linked from where it is developed, not copied under `node_modules`.
describe('a linked kay library', () => {
  let linked: string
  let library: string

  beforeAll(async () => {
    linked = await scratchDir('dom-')
    library = await scratchDir('dom-')
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
    const html = await Bun.file(join(out, 'index.html')).text()

    expect(html).toContain('<span class="badge lib-badge-class text-gray-500">hi default:hi</span>')
    // Named as an installed copy's island is, not by where the link points, in the markup and in the browser's registry alike.
    expect(html).toContain('data-component="node_modules/kay-lib/src/counter.kay"')
    expect((await Promise.all((await readdir(join(out, '_kay'))).filter(name => name.endsWith('.js')).map(async name => Bun.file(join(out, '_kay', name)).text()))).join('\n')).toContain('"node_modules/kay-lib/src/counter.kay"')
    expect(built.output).toContain('built 1 island')
    expect(checked.output).toMatch(/^checked with no problems in \d+ ms\n$/)
    expect(checked.code).toBe(0)
  })
})

// A workspace installs its packages once, in a `node_modules` above each app.
describe('a kay library hoisted above the project', () => {
  let workspace: string
  let project: string

  beforeAll(async () => {
    workspace = await scratchDir('dom-')
    project = join(workspace, 'apps/site')
    await write(project, { ...PROJECT, 'kay.config.ts': 'export default {}\n', 'src/routes/index.kay': '---\nimport Framed from \'kay-lib/framed.kay\'\n---\nmain\n  Framed(label="hi")\n' })
    await write(join(workspace, 'node_modules/kay-lib'), { ...LIBRARY, 'src/framed.kay': '---\nimport Badge from \'./badge.kay\'\n\nconst { label } = props<{ label: string }>()\n---\ndiv.frame\n  Badge(label={label})\n' })
  })

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('types its components, a component it imports beside one included, keeping their shadows inside the project\'s tree', async () => {
    expect(await run('check', project)).toEqual({ code: 0, output: expect.stringMatching(/^checked with no problems in \d+ ms\n$/) })
    expect(await Bun.file(join(project, '.kay/types/__/__/node_modules/kay-lib/src/framed.kay.tsx')).exists()).toBe(true)
    expect(await Bun.file(join(project, 'node_modules')).exists()).toBe(false)

    await write(project, { 'src/routes/typed.kay': '---\nimport Framed from \'kay-lib/framed.kay\'\n---\nFramed(label={1})\n' })

    const { code, output } = await run('check', project)

    expect(reported(output)).toEqual([`${relative(process.cwd(), join(project, 'src/routes/typed.kay'))}:4:8 error[TS2322]: Type 'number' is not assignable to type 'string'.`])
    expect(code).toBe(1)
  })
})

describe('throughLinks', () => {
  it('names a file of a linked package by its path under node_modules, scoped ones included, and leaves any other file as it is', async () => {
    const tree = await scratchDir('dom-')
    const app = join(tree, 'app')

    projects.push(tree)
    await write(tree, { 'lib/src/a.kay': 'p a\n', 'scoped/src/b.kay': 'p b\n', 'app/node_modules/@kaynooo/.keep': '' })
    await symlink(join(tree, 'lib'), join(app, 'node_modules/lib'))
    await symlink(join(tree, 'scoped'), join(app, 'node_modules/@kaynooo/ui'))
    // A link whose target is gone is skipped rather than failing every compile.
    await symlink(join(tree, 'gone'), join(app, 'node_modules/gone'))

    expect(throughLinks(app, join(tree, 'lib/src/a.kay'))).toBe(join(app, 'node_modules/lib/src/a.kay'))
    expect(throughLinks(app, join(tree, 'scoped/src/b.kay'))).toBe(join(app, 'node_modules/@kaynooo/ui/src/b.kay'))
    expect(throughLinks(app, join(tree, 'elsewhere/c.kay'))).toBe(join(tree, 'elsewhere/c.kay'))
    expect(throughLinks(app, join(app, 'src/d.kay'))).toBe(join(app, 'src/d.kay'))
  })

  it('names a file under a linked root by the root, inside a package linking an ancestor of it too, as a library repository linking itself into its example does', async () => {
    const repo = await scratchDir('dom-')
    const example = join(repo, 'examples/app')
    const link = join(repo, 'app-link')

    projects.push(repo)
    await write(repo, { 'src/lib.kay': 'p lib\n', 'examples/app/src/x.kay': 'p x\n', 'examples/app/node_modules/.keep': '' })
    await symlink('../../..', join(example, 'node_modules/repo'))
    await symlink(example, link)

    expect(throughLinks(link, join(example, 'src/x.kay'))).toBe(join(link, 'src/x.kay'))
    expect(throughLinks(link, join(repo, 'src/lib.kay'))).toBe(join(link, 'node_modules/repo/src/lib.kay'))
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
    const classes = (await Bun.file(projectPaths(project).classes).text()).split('\n')

    expect(html).toContain('<span class="badge lib-badge-class text-gray-500">hi app:hi</span>')
    expect(html).toContain('data-component="node_modules/kay-lib/src/counter.kay"')
    expect(scripts.join('\n')).toContain('app:')
    expect(scripts.join('\n')).not.toContain('never rendered')
    // The default tone lives in a script of the library, not in a template.
    expect(classes).toEqual(expect.arrayContaining(['badge', 'lib-badge-class', 'lib-counter-class', 'text-gray-500']))
    expect(classes).not.toContain('lib-unused-class')
  })

  it('builds a library with no island whose components hand a child what a function of its server code returns, the app\'s settings importing its main entry', async () => {
    const project = await scratchDir('mail-lib-')
    const out = join(project, 'out')

    projects.push(project)
    await write(project, {
      'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'mail-lib': '1.0.0' } }),
      'tsconfig.json': PROJECT['tsconfig.json']!,
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ settings: { \'mail-lib\': \'./src/mail-settings.ts\' } })\n',
      'src/mail-settings.ts': 'import { defaults } from \'mail-lib\'\n\nexport default { ...defaults, accent: \'red\' }\n',
      'src/routes/index.kay': '---\nimport Notice from \'mail-lib/notice.kay\'\n---\nmain\n  Notice(kind="link")\n',
    })
    await write(join(project, 'node_modules/mail-lib'), {
      'package.json': JSON.stringify({ name: 'mail-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay', '.': './src/index.ts' }, kay: { settings: './src/settings' } }),
      'src/defaults.ts': 'export const defaults = { accent: \'blue\' }\n',
      'src/settings.ts': 'export { defaults as default } from \'./defaults\'\n',
      'src/render.ts': 'import type { JSX } from \'kay\'\nimport { renderToString } from \'kay/server\'\n\nexport const LINKS = new Set([\'link\'])\n\nexport async function render(view: () => JSX.Element): Promise<string> {\n  return renderToString(view)\n}\n',
      'src/words.ts': 'import { LINKS } from \'./render\'\n\nexport function words(kind: string): string {\n  return LINKS.has(kind) ? \'Follow it\' : \'Read it\'\n}\n',
      'src/heading.kay': '---\nimport settings from \'./settings\'\n\nconst { text } = props<{ text: string }>()\n---\nh1(style={`color: ${settings.accent}`}) {text}\n',
      'src/notice.kay': '---\nimport Heading from \'./heading.kay\'\nimport { words } from \'./words\'\n\nconst { kind } = props<{ kind: string }>()\n---\nHeading(text={words(kind)})\n',
      'src/index.ts': 'export { defaults } from \'./defaults\'\nexport { render } from \'./render\'\nexport { words } from \'./words\'\n',
    })

    const { code, output } = await run('build', project, '--static', '--outdir', out)

    expect(output).not.toContain('error')
    expect(code).toBe(0)
    expect(await Bun.file(join(out, 'index.html')).text()).toContain('<h1 style="color: red">Follow it</h1>')
  })

  it('renders with the app\'s settings under kay test, whose preload registers the loader, a project nested below the working directory named by KAY_ROOT, and mounts a library component for the browser with its handlers running', async () => {
    const outer = await scratchDir('dom-')
    const sources = JSON.stringify(resolve('src/test'))

    projects.push(outer)
    await write(join(outer, 'fixture'), PROJECT)
    await write(join(outer, 'fixture/node_modules/kay-lib'), LIBRARY)
    // Imported before any `testSite` call, which only the preload makes possible.
    await Bun.write(join(outer, 'site.kay-test.ts'), `import { expect, it } from 'bun:test'\nimport { testSite } from ${sources}\nimport Badge from './fixture/node_modules/kay-lib/src/badge.kay'\n\nit('renders', async () => {\n  expect(Badge).toBeFunction()\n  expect((await (await testSite()).visit('/')).html).toContain('hi app:hi')\n})\n`)
    await Bun.write(join(outer, 'mount.kay-test.ts'), [
      'import { GlobalRegistrator } from \'@happy-dom/global-registrator\'',
      'import { expect, it } from \'bun:test\'',
      `import { mount, settle } from ${sources}`,
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
    ].join('\n'))

    const child = Bun.spawn([process.execPath, 'test', '--preload', resolve('src/test/preload.ts'), './site.kay-test.ts', './mount.kay-test.ts'], { cwd: outer, env: { ...process.env, KAY_ROOT: 'fixture' }, stdout: 'pipe', stderr: 'pipe' })
    const [output, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(output).toContain('2 pass')
    expect(output).toContain('0 fail')
    expect(code).toBe(0)
  })

  // A library linked from its own repository may hold the app checking it, as a playground does: the app's files stay its own.
  it('leaves errors inside a library\'s own modules to it, a missing optional peer included, and reports the app\'s calls into them, the library installed, linked or linked around the app', async () => {
    await Promise.all((['installed', 'linked', 'linked around the app'] as const).map(async (layout) => {
      const library = layout === 'installed' ? undefined : await scratchDir('dom-')
      const project = layout === 'linked around the app' ? join(library!, 'playground') : await newProject()

      if (library !== undefined) {
        projects.push(library)
        await write(library, LIBRARY)
      }

      if (layout === 'linked around the app')
        await write(project, PROJECT)

      if (library !== undefined) {
        await rm(join(project, 'node_modules/kay-lib'), { recursive: true, force: true })
        await Bun.write(join(project, 'node_modules/.keep'), '')
        await symlink(library, join(project, 'node_modules/kay-lib'))
      }

      await write(library ?? join(project, 'node_modules/kay-lib'), {
        // An optional peer the app has not installed, imported by a component it uses and by one it never imports.
        'src/media.ts': 'export async function player(): Promise<unknown> {\n  try {\n    const { default: Player } = await import(\'optional-player\')\n\n    return Player\n  }\n  catch {\n    return undefined\n  }\n}\n\nexport function scale(value: number): number {\n  return value * 2\n}\n',
        'src/axis.ts': 'import { Axis } from \'optional-chart\'\n\nexport const axis = new Axis()\n',
        'src/video.kay': '---\nimport { onMount } from \'kay\'\nimport { player } from \'./media\'\n\nonMount(() => void player())\n---\nvideo\n',
        'src/chart.kay': '---\nimport { axis } from \'./axis\'\n---\np {String(axis)}\n',
        'src/index.ts': `${LIBRARY['src/index.ts']}export { scale } from './media'\n`,
      })
      await write(project, {
        'src/routes/video.kay': '---\nimport Video from \'kay-lib/video.kay\'\n---\nVideo\n',
        'src/doubled.ts': 'import { scale } from \'kay-lib\'\n\nexport const doubled = scale(\'two\')\n',
      })

      const { code, output } = await run('check', project)

      expect(reported(output)).toEqual([
        `${relative(process.cwd(), join(project, 'src/doubled.ts'))}:3:30 error[TS2345]: Argument of type 'string' is not assignable to parameter of type 'number'.`,
      ])
      expect(code).toBe(1)
    }))
  })

  it('types a library\'s components in the app, reporting an error inside one the app uses at its own line, and the app\'s settings against the defaults, leaving a glob it cannot read to the check or the build reporting it', async () => {
    const project = await newProject()

    await write(project, {
      'src/routes/typed.kay': '---\nimport Badge from \'kay-lib/badge.kay\'\nimport Typo from \'kay-lib/typo.kay\'\n---\nBadge(label={1})\nTypo(size={2})\n',
      'src/ui-settings.ts': 'const settings = { tone: 1, icon: (name: string) => name }\n\nexport default settings\n',
      'src/globbed.ts': 'const pattern = \'./notes/*.ts\'\n\nexport const notes = import.meta.glob(pattern)\n',
      'src/routes/notes.kay': '---\nimport Badge from \'kay-lib/badge.kay\'\nimport { notes } from \'../globbed\'\n---\nBadge(label={String(Object.keys(notes).length)})\n',
    })
    await write(join(project, 'node_modules/kay-lib'), { 'src/typo.kay': '---\nconst { size } = props<{ size: number }>()\n---\np {size.toFixed(1).missing}\n' })

    const { code, output } = await run('check', project)

    expect(code).toBe(1)
    expect(output).not.toContain('takes its patterns as strings written in the call')

    expect(reported(output)).toEqual([
      `${relative(process.cwd(), join(project, 'src/ui-settings.ts'))}:1:1 error[TS2322]: The settings for kay-lib do not match what it takes: Type '{ tone: number; icon: (name: string) => string; }' is not assignable to type 'Settings'.`,
      `${relative(process.cwd(), join(project, 'node_modules/kay-lib/src/typo.kay'))}:4:20 error[TS2339]: Property 'missing' does not exist on type 'string'.`,
      `${relative(process.cwd(), join(project, 'src/routes/typed.kay'))}:5:7 error[TS2322]: Type 'number' is not assignable to type 'string'.`,
    ])
  })
})
