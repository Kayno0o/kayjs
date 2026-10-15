import type { ClientOptions } from '../src/build/client'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { findKayLibraries } from '../src/build/libraries'
import { classTokens, pruneClasses, pruneNodes, unusedLibraryClasses } from '../src/build/prune'
import { mergeSupports, mergingSupports, parse, print } from '../src/build/supports'
import { devBuilder } from '../src/dev/builder'
import { stylesOnly, watchProject } from '../src/dev/sources'
import { scratchDir } from './scratch'

const projects: string[] = []

afterAll(async () => {
  await Promise.all(projects.map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('classTokens', () => {
  it('yields each run of class characters one at a time, never as one array of them all', () => {
    const tokens = classTokens('{"a": "hover:kui-btn md:[x]/y", "n": 12}')

    expect(Array.isArray(tokens)).toBe(false)
    expect(tokens.next()).toEqual({ done: false, value: 'a' })
    expect([...tokens]).toEqual(['hover', 'kui-btn', 'md', 'x', 'y', 'n', '12'])
    expect([...classTokens('')]).toEqual([])
  })
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

  it('prunes a parsed stylesheet the way the text is, so one parse serves the pruning and the merge', () => {
    const css = '@supports (display:grid){.a{--x:1}}.gone{c:d}@supports (display:grid){.b{--y:1}}.kept{e:f}'

    expect(print(pruneNodes(parse(css), unused))).toBe(pruneClasses(css, unused))
    expect(pruneNodes(parse(css), new Set())).toEqual(parse(css))
  })

  it('merges the blocks pruning leaves one after the other, in one pass over the output', async () => {
    const dir = await scratchDir('prune-merge-')
    const css = '@supports (display:grid){.a{--x:1}}\n.gone{c:d}\n@supports (display:grid){.b{--y:1}}\n'

    projects.push(dir)
    await Bun.write(join(dir, 'in.css'), css)

    const build = await Bun.build({ entrypoints: [join(dir, 'in.css')], plugins: mergingSupports([], async nodes => pruneNodes(nodes, await Promise.resolve(unused))) })
    const out = await build.outputs[0]!.text()

    expect(out).not.toContain('gone')
    expect(out.match(/@supports/g)).toHaveLength(1)
    expect(out).toContain('--x')
    expect(out).toContain('--y')
    expect(mergeSupports(pruneClasses(css, unused)).match(/@supports/g)).toHaveLength(1)
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

  it('reads a large data file of the app for the classes it names', async () => {
    const root = await newProject(PLAIN_CSS)
    const rows = Array.from({ length: 200_000 }, (_, index) => `{"id":${index},"name":"row ${index}"}`)

    await Bun.write(join(root, 'src/data.json'), `[${rows.join(',')},{"class":"ui-unused"}]`)

    const unused = await unusedLibraryClasses(root, await findKayLibraries(root), [])

    expect(unused).not.toContain('ui-unused')
    expect(unused).toContain('ui-unused-too')
  })

  it('prunes the stylesheets an exported one pulls in with a relative import, however deep, and leaves the unexported ones that nothing imports', async () => {
    const root = await newProject(PLAIN_CSS)
    const library = join(root, 'node_modules/ui-lib')
    const theme = join(library, 'src/theme.css')

    await Promise.all([
      Bun.write(theme, `@import "./parts/extra.css";\n@import url(./parts/quoted.css);\n${LIBRARY_THEME}`),
      Bun.write(join(library, 'src/parts/extra.css'), '@import\'../deep.css\';\n.ui-part { padding: 12px; }\n.ui-part-used { padding: 13px; }\n'),
      Bun.write(join(library, 'src/parts/quoted.css'), '.ui-quoted { padding: 14px; }\n'),
      Bun.write(join(library, 'src/deep.css'), '.ui-deep { padding: 15px; }\n'),
      Bun.write(join(root, 'src/notes.txt'), 'ui-part-used\n'),
    ])

    const unused = await unusedLibraryClasses(root, await findKayLibraries(root), [])

    expect([...unused].filter(name => (/part|deep|quoted/).test(name)).sort()).toEqual(['ui-deep', 'ui-part', 'ui-quoted'])
    expect(unused).not.toContain('ui-demo')
    expect(libraryRules(await pageCss(root, {}))).toEqual([...KEPT, '.ui-part-used'].sort())
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

  it('builds the stylesheets again in kay dev once a root Markdown file names a class it pruned, which the watcher reports without a restart', async () => {
    const root = await newProject(PLAIN_CSS)
    const build = devBuilder(root, {})
    const stylesheet = async (styles: Record<string, string> | undefined) => Bun.file(join(clientDir(root), styles!['src/routes/index.kay']!.slice('/_kay/'.length))).text()
    const changes: string[] = []
    const stop = watchProject(root, file => changes.push(file), { rootNaming: true })

    try {
      expect(libraryRules(await stylesheet((await build(null)).styles))).toEqual(KEPT)

      await build([])
      await Bun.write(join(root, 'NOTES.md'), 'The `ui-unused-too` class.\n')

      for (let waited = 0; waited < 5000 && !changes.includes('NOTES.md'); waited += 100) {
        await Bun.write(join(root, 'NOTES.md'), `The \`ui-unused-too\` class ${waited}.\n`)
        await Bun.sleep(100)
      }

      expect(changes).toContain('NOTES.md')
      expect(stylesOnly('NOTES.md')).toBe(true)
      expect(libraryRules(await stylesheet((await build(['NOTES.md'])).styles))).toEqual([...KEPT, '.ui-unused-too'].sort())
    }
    finally {
      stop()
    }
  })

  it('tells a change that only needs the stylesheets built again from one that restarts the server', () => {
    expect(['a.css', 'src/a.css', 'README.md', 'docs.mdx', 'index.htm'].map(stylesOnly)).toEqual([true, true, true, true, true])
    expect(['src/README.md', 'src/content/a.md', 'a.ts', 'index.html', 'package.json', 'LICENSE'].map(stylesOnly)).toEqual([false, false, false, false, false, false])
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
