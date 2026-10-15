import type { ClientOptions } from '../src/build/client'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { findKayLibraries } from '../src/build/libraries'
import { pruneClasses, unusedLibraryClasses } from '../src/build/prune'
import { devBuilder } from '../src/dev/builder'
import { scratchDir } from './scratch'

const projects: string[] = []

afterAll(async () => {
  await Promise.all(projects.map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('pruneClasses', () => {
  const unused = new Set(['gone', 'gone-too'])

  it('drops a rule whose selector needs an unused class, and only the selectors of a list that do', () => {
    expect(pruneClasses('.kept{a:b}.gone{c:d}', unused)).toBe('.kept{a:b}')
    expect(pruneClasses('.gone, .kept > p, .x.gone-too{a:b}', unused)).toBe(' .kept > p{a:b}')
    expect(pruneClasses('a.gone:hover, .gone::before{a:b}', unused)).toBe('')
  })

  it('keeps a selector naming an unused class only inside a pseudo-class or an attribute', () => {
    const css = ':is(.gone, .kept)::before{a:b}:where(.gone:hover) .kept{c:d}.kept:not(.gone){e:f}[data-x=".gone"]{g:h}'

    expect(pruneClasses(css, unused)).toBe(css)
  })

  it('keeps the place of a named layer it empties in the order of layers', () => {
    expect(pruneClasses('@layer base{.gone{a:b}}@layer{.gone{a:b}}@layer components{.kept{c:d}}', unused)).toBe('@layer base;@layer components{.kept{c:d}}')
  })

  it('looks into conditional at-rules and nested rules, dropping the blocks it empties, and leaves keyframes, fonts and properties alone', () => {
    expect(pruneClasses('@layer components{.gone{a:b}@media (width >= 40rem){.gone{c:d}}.kept{e:f}}', unused)).toBe('@layer components{.kept{e:f}}')
    expect(pruneClasses('@media print{.gone{a:b}}@container x (width > 1px){.gone{a:b}}@supports (display: grid){.gone{a:b}}', unused)).toBe('')
    expect(pruneClasses('.kept{color:red;&.gone{a:b}& .kept{c:d}@media print{.gone{e:f}}}', unused)).toBe('.kept{color:red;& .kept{c:d}}')
    expect(pruneClasses('.kept{color:red;@media print{color:blue}}', unused)).toBe('.kept{color:red;@media print{color:blue}}')

    const left = '@keyframes gone{from{a:b}}@font-face{font-family:gone}@property --gone{syntax:"*"}@layer a, b;'

    expect(pruneClasses(left, unused)).toBe(left)
  })

  it('never takes an escaped class, a string or a comment for one it may drop', () => {
    const css = '.gone\\:x{a:b}.md\\:gone{c:d}/* .gone{ */.kept[title="}.gone{"]{e:f}'

    expect(pruneClasses(css, unused)).toBe(css)
  })

  it('leaves a stylesheet alone when nothing is unused', () => {
    expect(pruneClasses('.gone{a:b}', new Set())).toBe('.gone{a:b}')
  })
})

const LIBRARY_THEME = `@layer components {
  .ui-card { padding: 1px; }
  .ui-unused, .ui-unused-too { padding: 2px; }
  .ui-island { padding: 3px; }
  .ui-server { padding: 4px; }
  .ui-callout { padding: 5px; }
  .ui-prop { padding: 6px; }
  .ui-restyled { padding: 7px; }
  .ui-commented { padding: 10px; }
  .ui-tone-warn { padding: 11px; }
  @media (width >= 40rem) {
    .ui-unused { padding: 8px; }
    .ui-card { padding: 9px; }
  }
}
`

// A UI library as it is installed: a theme with a rule per component, the components, and a stylesheet of its examples it does not export.
const LIBRARY: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'ui-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay', './theme.css': './src/theme.css' } }),
  'src/theme.css': LIBRARY_THEME,
  'src/card.kay': '---\nconst { label } = props<{ label: string }>()\n---\ndiv.ui-card {label}\n',
  'src/box.kay': '---\nconst { class: extra } = props<{ class?: string }>()\n---\ndiv(class={extra}) box\n',
  'src/callout.kay': 'div.ui-callout\n  slot\n',
  'src/unused.kay': 'div.ui-unused never rendered\n',
  'examples/demo.css': '.ui-demo { padding: 0; }\n',
}

// The app renders some of the library's components, a Markdown entry another, an island toggles a class at runtime and puts another together there.
function project(css: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'ui-lib': '1.0.0' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
    'src/app.css': css,
    'src/content.config.ts': 'import { collection } from \'kay/content\'\nimport Callout from \'ui-lib/callout.kay\'\n\nexport const notes = collection(\'content/notes\', { components: { Callout } })\n',
    'src/content/notes/first.md': '---\ntitle: First\n---\n\n<Callout>\n\nHi\n\n</Callout>\n',
    'src/components/toggle.kay': '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\nbutton(onClick={(event: MouseEvent) => { open.set(o => !o); (event.currentTarget as HTMLElement).classList.toggle(\'ui-island\', open()) }}) toggle\nspan(class={\'ui-tone-\' + (open() ? \'warn\' : \'calm\')}) tone\n',
    'src/routes/index.kay': '--- server\nimport { notes } from \'../content.config\'\n\nconst { Content } = (await notes.get(\'first\'))!\n--- script\nimport \'../app.css\'\nimport Box from \'ui-lib/box.kay\'\nimport Card from \'ui-lib/card.kay\'\nimport Toggle from \'../components/toggle.kay\'\n---\nmain.ui-server\n  Card(label="hi")\n  Box(class="ui-prop")\n  Toggle\n  Content\n',
  }
}

const PLAIN_CSS = '@import "ui-lib/theme.css";\n/* Put together at runtime: ui-commented */\n.ui-restyled { outline: 1px solid; }\n'
const TAILWIND_CSS = `@import "tailwindcss" source("..");\n${PLAIN_CSS}`

// The library is linked from where it is developed when `linked`, as a workspace's is.
async function newProject(css: string, linked = false): Promise<string> {
  const dir = await scratchDir('prune-')
  const library = linked ? await scratchDir('prune-lib-') : join(dir, 'node_modules/ui-lib')

  projects.push(dir, library)
  await Promise.all([...Object.entries(project(css)).map(async ([name, text]) => Bun.write(join(dir, name), text)), ...Object.entries(LIBRARY).map(async ([name, text]) => Bun.write(join(library, name), text))])

  if (linked) {
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await symlink(library, join(dir, 'node_modules/ui-lib'))
  }

  return dir
}

async function pageCss(root: string, options: ClientOptions): Promise<string> {
  const client = await buildClient(root, options)

  return Bun.file(join(client.dir, client.styles.get(join(root, 'src/routes/index.kay'))!.slice('/_kay/'.length))).text()
}

// The rules a stylesheet holds for the library's classes, by class.
function libraryRules(css: string): string[] {
  return [...new Set(css.match(/\.ui-[\w-]+/g) ?? [])].sort()
}

const KEPT = ['.ui-callout', '.ui-card', '.ui-commented', '.ui-island', '.ui-prop', '.ui-restyled', '.ui-server']

describe('a library\'s stylesheet in an app', () => {
  it.each([['installed', false], ['linked', true]] as const)('ships only the rules of the classes the app\'s files and the library files it reaches name, in production, the library %s', async (_, linked) => {
    const root = await newProject(PLAIN_CSS, linked)
    const css = await pageCss(root, {})

    // A class put together at runtime is not seen; one written whole in a comment is.
    expect(libraryRules(css)).toEqual(KEPT)
    expect(css).toContain('padding: 9px')
    expect(css).not.toContain('padding: 8px')
    expect(css).toContain('outline: 1px solid')
    expect(css).toContain('padding: 7px')
  })

  it('reads the classes of the stylesheets the library exports alone', async () => {
    const root = await newProject(PLAIN_CSS)
    const unused = await unusedLibraryClasses(root, await findKayLibraries(root), [])

    expect(unused).toContain('ui-unused')
    expect(unused).not.toContain('ui-demo')
  })

  it('prunes what Tailwind inlines of it as well', async () => {
    const root = await newProject(TAILWIND_CSS)
    const css = await pageCss(root, { plugins: [tailwind] })

    expect(libraryRules(css)).toEqual(KEPT)
    expect(css).toContain('outline: 1px solid')
  })

  it.each([['with', TAILWIND_CSS, [tailwind]], ['without', PLAIN_CSS, []]] as const)('prunes it in kay dev %s Tailwind, and builds the stylesheets again once a file names a class it pruned', async (_, css, plugins) => {
    const root = await newProject(css)
    const page = join(root, 'src/routes/index.kay')
    const build = devBuilder(root, { plugins: [...plugins] })
    const stylesheet = async (styles: Record<string, string> | undefined) => Bun.file(join(clientDir(root), styles!['src/routes/index.kay']!.slice('/_kay/'.length))).text()
    const first = await build(null)

    expect(libraryRules(await stylesheet(first.styles))).toEqual(KEPT)

    await build([])
    await Bun.write(page, `${await Bun.file(page).text()}  p.ui-unused-too\n`)

    const again = await build(['src/routes/index.kay'])

    expect(libraryRules(await stylesheet(again.styles))).toEqual([...KEPT, '.ui-unused-too'].sort())
  })

  it('builds the stylesheets again in kay dev once the app reaches a library component naming a class it pruned, from a file naming none', async () => {
    const root = await newProject(PLAIN_CSS)
    const config = join(root, 'src/content.config.ts')
    const build = devBuilder(root, {})
    const stylesheet = async (styles: Record<string, string> | undefined) => Bun.file(join(clientDir(root), styles!['src/routes/index.kay']!.slice('/_kay/'.length))).text()

    expect(libraryRules(await stylesheet((await build(null)).styles))).toEqual(KEPT)

    await build([])
    await Bun.write(config, (await Bun.file(config).text()).replace('import Callout', 'import Shown from \'ui-lib/unused.kay\'\nimport Callout').replace('{ Callout }', '{ Callout, Shown }'))

    expect(libraryRules(await stylesheet((await build(['src/content.config.ts'])).styles))).toEqual([...KEPT, '.ui-unused'].sort())
  })
})
