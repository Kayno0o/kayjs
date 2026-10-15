import type { ClientOptions } from '../src/build/client'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { pruneClasses } from '../src/build/prune'
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
  @media (width >= 40rem) {
    .ui-unused { padding: 8px; }
    .ui-card { padding: 9px; }
  }
}
`

// A UI library as it is installed: a theme with a rule per component, and the components; the app renders some, a Markdown entry another, and an island toggles a class at runtime.
function project(css: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'ui-lib': '1.0.0' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
    'node_modules/ui-lib/package.json': JSON.stringify({ name: 'ui-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay', './theme.css': './src/theme.css' } }),
    'node_modules/ui-lib/src/theme.css': LIBRARY_THEME,
    'node_modules/ui-lib/src/card.kay': '---\nconst { label } = props<{ label: string }>()\n---\ndiv.ui-card {label}\n',
    'node_modules/ui-lib/src/box.kay': '---\nconst { class: extra } = props<{ class?: string }>()\n---\ndiv(class={extra}) box\n',
    'node_modules/ui-lib/src/callout.kay': 'div.ui-callout\n  slot\n',
    'node_modules/ui-lib/src/unused.kay': 'div.ui-unused never rendered\n',
    'src/app.css': css,
    'src/content.config.ts': 'import { collection } from \'kay/content\'\nimport Callout from \'ui-lib/callout.kay\'\n\nexport const notes = collection(\'content/notes\', { components: { Callout } })\n',
    'src/content/notes/first.md': '---\ntitle: First\n---\n\n<Callout>\n\nHi\n\n</Callout>\n',
    'src/components/toggle.kay': '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\nbutton(onClick={(event: MouseEvent) => { open.set(o => !o); (event.currentTarget as HTMLElement).classList.toggle(\'ui-island\', open()) }}) toggle\n',
    'src/routes/index.kay': '--- server\nimport { notes } from \'../content.config\'\n\nconst { Content } = (await notes.get(\'first\'))!\n--- script\nimport \'../app.css\'\nimport Box from \'ui-lib/box.kay\'\nimport Card from \'ui-lib/card.kay\'\nimport Toggle from \'../components/toggle.kay\'\n---\nmain.ui-server\n  Card(label="hi")\n  Box(class="ui-prop")\n  Toggle\n  Content\n',
  }
}

const PLAIN_CSS = '@import "ui-lib/theme.css";\n.ui-restyled { outline: 1px solid; }\n'
const TAILWIND_CSS = `@import "tailwindcss" source("..");\n${PLAIN_CSS}`

async function newProject(css: string): Promise<string> {
  const dir = await scratchDir('prune-')

  projects.push(dir)
  await Promise.all(Object.entries(project(css)).map(async ([name, text]) => Bun.write(join(dir, name), text)))

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

const KEPT = ['.ui-callout', '.ui-card', '.ui-island', '.ui-prop', '.ui-restyled', '.ui-server']

describe('a library\'s stylesheet in an app', () => {
  it('ships only the rules of the classes the app\'s files and the library files it reaches name, in production', async () => {
    const root = await newProject(PLAIN_CSS)
    const css = await pageCss(root, {})

    expect(libraryRules(css)).toEqual(KEPT)
    expect(css).toContain('padding: 9px')
    expect(css).not.toContain('padding: 8px')
    expect(css).toContain('outline: 1px solid')
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
})
