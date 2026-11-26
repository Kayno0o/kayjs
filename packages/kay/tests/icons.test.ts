import type { IconSet } from '../../plugin-icons/src/index'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { iconData } from '../../plugin-icons/src/icon-data'
import { icons } from '../../plugin-icons/src/plugin'
import { svgIcon } from '../../plugin-icons/src/svg-dir'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { createServer } from '../src/server/index'

const DEMO: IconSet = {
  prefix: 'demo',
  width: 24,
  height: 24,
  icons: { arrow: { body: '<path d="M5 12h14"/>' }, wide: { body: '<rect width="32" height="16"/>', width: 32, height: 16 } },
}
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

// An app installing @kayjs/icons and @kayjs/kay as links, the way a workspace or `file:` dependency does.
function linkedApp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kay-icons-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '../../plugin-icons'), join(root, 'node_modules/@kayjs/icons'))
  symlinkSync(join(import.meta.dir, '..'), join(root, 'node_modules/@kayjs/kay'))

  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), source)
  }

  return root
}

function clientJs(root: string): string {
  const dir = join(root, 'dist/_kay')
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.js')).map(file => readFileSync(join(dir, file), 'utf8')).join('\n')
}

// The <main> of a static page rendering `jsx` with the demo icon imported as `arrow`.
async function staticMain(jsx: string): Promise<string> {
  const root = linkedApp({
    'src/routes/index.tsx': `
      import { Icon } from '@kayjs/icons'
      import arrow from '~icons/demo/arrow'
      export default function Home() { return <main>${jsx}</main> }
    `,
  })
  await build({ root, plugins: [icons({ sets: { demo: DEMO } })], static: true })
  return /<main>.*<\/main>/s.exec(readFileSync(join(root, 'dist/index.html'), 'utf8'))![0]
}

describe('<Icon> on the server', () => {
  it('lets the caller\'s width, height and viewBox replace the icon\'s', async () => {
    expect(await staticMain('<Icon icon={arrow} width="24" height="24" viewBox="0 0 12 12" />'))
      .toBe('<main><svg viewBox="0 0 12 12" width="24" height="24" aria-hidden="true"><path d="M5 12h14"/></svg></main>')
  })

  it('names the icon from aria-label, hiding it otherwise', async () => {
    expect(await staticMain('<Icon icon={arrow} aria-label="Next" /><Icon icon={arrow} />'))
      .toBe('<main><svg aria-label="Next" viewBox="0 0 24 24" width="1em" height="1em" role="img"><path d="M5 12h14"/></svg><svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path d="M5 12h14"/></svg></main>')
  })

  it('names the icon from aria-labelledby', async () => {
    expect(await staticMain('<Icon icon={arrow} aria-labelledby="next" />'))
      .toBe('<main><svg aria-labelledby="next" viewBox="0 0 24 24" width="1em" height="1em" role="img"><path d="M5 12h14"/></svg></main>')
  })

  it('hides an icon whose aria-label is blank, as a blank label names nothing', async () => {
    expect(await staticMain('<Icon icon={arrow} aria-label=" " />'))
      .toBe('<main><svg aria-label=" " viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path d="M5 12h14"/></svg></main>')
  })

  it('keeps the caller\'s role and aria-hidden', async () => {
    expect(await staticMain('<Icon icon={arrow} aria-label="Next" role="presentation" aria-hidden="true" />'))
      .toBe('<main><svg aria-label="Next" viewBox="0 0 24 24" width="1em" height="1em" role="presentation" aria-hidden="true"><path d="M5 12h14"/></svg></main>')
  })
})

describe('@kayjs/icons in an island', () => {
  it('builds an island rendering <Icon> imported from @kayjs/icons', async () => {
    const root = linkedApp({
      'src/Counter.tsx': `
        import { signal } from '@kayjs/kay'
        import { Icon } from '@kayjs/icons'
        import arrow from '~icons/demo/arrow'
        export function Counter() {
          const count = signal(0)
          return <button onClick={() => count.value++}><Icon icon={arrow} />{count.value}</button>
        }
      `,
      'src/routes/index.tsx': `
        import { Counter } from '../Counter'
        export default function Home() { return <main><Counter /></main> }
      `,
    })

    await build({ root, plugins: [icons({ sets: { demo: DEMO } })], static: true })

    expect(clientJs(root)).toContain('M5 12h14')
  })
})

// Hydrates the one island of `src/routes/index.tsx` over its server HTML in happy-dom, handing `use` its host and a hydrate call.
async function withHydratedIsland(files: Record<string, string>, use: (host: HTMLElement, hydrate: () => void) => void): Promise<void> {
  const root = linkedApp(files)
  const manifest = await build({ root, plugins: [icons({ sets: { demo: DEMO } })], minify: false })
  const app = await createServer({ root })
  const html = await (await app.handle(new Request('http://localhost/'))).text()
  const chunk = (url: string) => join(root, 'dist/client', url.replace('/_kay/', ''))

  GlobalRegistrator.register()
  try {
    const runtime = await import(chunk(manifest.runtimeScript!)) as { hydrate: (el: Element, render: () => Node | null) => () => void }
    const island = await import(chunk(Object.values(manifest.islands)[0]!)) as { default: () => Node | null }
    const host = document.createElement('div')
    host.innerHTML = /<kay-island[^>]*>([\s\S]*?)<\/kay-island>/.exec(html)![1]!
    document.body.appendChild(host)
    use(host, () => runtime.hydrate(host, () => island.default()))
  }
  finally {
    await GlobalRegistrator.unregister()
  }
}

describe('<Icon> in a hydrated island', () => {
  it('keeps the caller\'s width and follows its label when the icon and the label change', async () => {
    await withHydratedIsland({
      'src/Swap.tsx': `
        import { signal } from '@kayjs/kay'
        import { Icon } from '@kayjs/icons'
        import arrow from '~icons/demo/arrow'
        import wide from '~icons/demo/wide'
        export function Swap() {
          const on = signal(false)
          return <button type="button" onClick={() => { on.value = true }}><Icon icon={on.value ? wide : arrow} width="3em" aria-label={on.value ? 'Wide' : undefined} /></button>
        }
      `,
      'src/routes/index.tsx': `import { Swap } from '../Swap'\nexport default function Home() { return <main><Swap /></main> }`,
    }, (host, hydrate) => {
      hydrate()
      host.querySelector('button')!.click()
      const svg = host.querySelector('svg')!

      expect([svg.getAttribute('viewBox'), svg.getAttribute('width'), svg.getAttribute('role'), svg.getAttribute('aria-hidden')]).toEqual(['0 0 32 16', '3em', 'img', null])
    })
  })

  it('adopts the server-rendered SVG body rather than parsing it again', async () => {
    await withHydratedIsland({
      'src/Counter.tsx': `
        import { signal } from '@kayjs/kay'
        import { Icon } from '@kayjs/icons'
        import arrow from '~icons/demo/arrow'
        export function Counter() {
          const count = signal(0)
          return <button type="button" onClick={() => count.value++}><Icon icon={arrow} />{count.value}</button>
        }
      `,
      'src/routes/index.tsx': `import { Counter } from '../Counter'\nexport default function Home() { return <main><Counter /></main> }`,
    }, (host, hydrate) => {
      const path = host.querySelector('path')
      hydrate()

      expect(host.querySelector('path') === path).toBe(true)
    })
  })
})

describe('iconData', () => {
  // A 32×16 glyph, wider than tall, so a quarter turn shows in the viewBox.
  const wide = (alias: IconSet['icons'][string], set: Partial<IconSet> = {}): ReturnType<typeof iconData> =>
    iconData({ prefix: 'w', width: 32, height: 16, icons: { a: { body: '<path/>' } }, aliases: { x: { parent: 'a', ...alias } }, ...set }, 'x')

  it('turns a quarter rotation about the glyph and swaps the viewBox sides', () => {
    expect(wide({ rotate: 1 })).toEqual({ viewBox: '0 0 16 32', width: '0.5em', height: '1em', body: '<g transform="rotate(90 8 8)"><path/></g>' })
  })

  it('reads a negative rotation as the same turn counted forward', () => {
    expect(wide({ rotate: -1 })).toEqual({ viewBox: '0 0 16 32', width: '0.5em', height: '1em', body: '<g transform="rotate(-90 16 16)"><path/></g>' })
  })

  it('drops a full turn', () => {
    expect(wide({ rotate: 4 })).toEqual({ viewBox: '0 0 32 16', width: '2em', height: '1em', body: '<path/>' })
  })

  it('rotates the flipped glyph, as Iconify does', () => {
    expect(wide({ hFlip: true, rotate: 1 })).toEqual({ viewBox: '0 0 16 32', width: '0.5em', height: '1em', body: '<g transform="rotate(90 8 8) translate(32 0) scale(-1 1)"><path/></g>' })
  })

  it('draws both flips as a half turn', () => {
    expect(wide({ hFlip: true, vFlip: true })).toEqual({ viewBox: '0 0 32 16', width: '2em', height: '1em', body: '<g transform="rotate(180 16 8)"><path/></g>' })
  })

  it('draws a flipped glyph with an offset in a box at the origin', () => {
    expect(wide({ hFlip: true }, { left: 2, top: 3 })).toEqual({ viewBox: '0 0 32 16', width: '2em', height: '1em', body: '<g transform="translate(34 -3) scale(-1 1)"><path/></g>' })
  })

  it('takes left and top from the set when the icon has none', () => {
    expect(wide({}, { left: 2, top: 3 })?.viewBox).toBe('2 3 32 16')
  })

  it('finds no icon of zero height', () => {
    expect(wide({ height: 0 })).toBeUndefined()
  })
})

describe('icons() loading an installed set', () => {
  it('reads and parses a set once however many of its icons a build imports', async () => {
    const root = linkedApp({
      'node_modules/@iconify-json/demo/icons.json': JSON.stringify(DEMO),
      'src/routes/index.tsx': `
        import { Icon } from '@kayjs/icons'
        import a from '~icons/demo/arrow'
        import b from '~icons/demo/wide'
        import c from '~icons/demo/demo:arrow'
        export default function Home() { return <main><Icon icon={a} /><Icon icon={b} /><Icon icon={c} /></main> }
      `,
    })
    const file = spyOn(Bun, 'file')

    try {
      await build({ root, plugins: [icons()], static: true })

      expect(file.mock.calls.filter(([path]) => String(path).endsWith('@iconify-json/demo/icons.json'))).toHaveLength(1)
    }
    finally {
      file.mockRestore()
    }
  })

  it('loads a set installed after a build failed to find it', async () => {
    const root = linkedApp({
      'src/routes/index.tsx': `
        import { Icon } from '@kayjs/icons'
        import arrow from '~icons/demo/arrow'
        export default function Home() { return <main><Icon icon={arrow} /></main> }
      `,
    })
    const plugin = icons()

    await expect(build({ root, plugins: [plugin], static: true })).rejects.toThrow('@iconify-json/demo')
    mkdirSync(join(root, 'node_modules/@iconify-json/demo'), { recursive: true })
    writeFileSync(join(root, 'node_modules/@iconify-json/demo/icons.json'), JSON.stringify(DEMO))
    await build({ root, plugins: [plugin], static: true })

    expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).toContain('M5 12h14')
  })
})

describe('svgIcon', () => {
  it('keeps the glyph and the viewBox, wrapping the root\'s paint attributes around the glyph', () => {
    expect(svgIcon('<?xml version="1.0"?>\n<!-- <svg viewBox="0 0 1 1"> -->\n<svg xmlns="http://www.w3.org/2000/svg" class="logo" viewBox="2,1 32 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M0 0h32"/></svg>\n'))
      .toEqual({ body: '<g fill="none" stroke="currentColor" stroke-width="2"><path d="M0 0h32"/></g>', left: 2, top: 1, width: 32, height: 16 })
  })

  it('sizes an SVG with no viewBox from its width and height', () => {
    expect(svgIcon('<svg width="24px" height=\'20\'><circle r="4"/></svg>')).toEqual({ body: '<circle r="4"/>', left: 0, top: 0, width: 24, height: 20 })
  })

  it('sizes an SVG from its width and height when its viewBox is malformed', () => {
    expect(svgIcon('<svg viewBox="0 0 24" width="16" height="16"><circle r="4"/></svg>')).toEqual({ body: '<circle r="4"/>', left: 0, top: 0, width: 16, height: 16 })
  })

  it('refuses an SVG with no size', () => {
    expect(svgIcon('<svg width="100%" height="100%"><circle r="4"/></svg>')).toBe('has no viewBox, nor a width and height, to size it: add viewBox="0 0 <width> <height>" to its <svg>')
  })

  it('refuses an SVG whose viewBox has no area', () => {
    expect(svgIcon('<svg viewBox="0 0 0 16"><circle r="4"/></svg>')).toBe('has no viewBox, nor a width and height, to size it: add viewBox="0 0 <width> <height>" to its <svg>')
  })

  it('refuses a file with no <svg> element', () => {
    expect(svgIcon('<!-- <svg viewBox="0 0 1 1"></svg> -->')).toBe('holds no <svg> element')
  })
})

describe('a folder of .svg files as a set', () => {
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><path d="M0 0h32"/></svg>'
  const page = (...specifiers: string[]): Record<string, string> => ({
    'src/routes/index.tsx': `import { Icon } from '@kayjs/icons'\n${specifiers.map((specifier, i) => `import icon${i} from '${specifier}'`).join('\n')}\nexport default function Home() { return <main>${specifiers.map((_, i) => `<Icon icon={icon${i}} />`).join('')}</main> }\n`,
  })
  const html = (root: string): string => /<main>.*<\/main>/s.exec(readFileSync(join(root, 'dist/index.html'), 'utf8'))![0]

  it('reads src/icons as the set local, with no option', async () => {
    const root = linkedApp({ ...page('~icons/local/logo'), 'src/icons/logo.svg': LOGO })
    await build({ root, plugins: [icons()], static: true })

    expect(html(root)).toBe('<main><svg viewBox="0 0 32 16" width="2em" height="1em" aria-hidden="true"><path d="M0 0h32"/></svg></main>')
  })

  it('reads the folder once however many of its icons a build imports', async () => {
    const root = linkedApp({ ...page('~icons/local/logo', '~icons/local/mark'), 'src/icons/logo.svg': LOGO, 'src/icons/mark.svg': LOGO })
    const file = spyOn(Bun, 'file')

    try {
      await build({ root, plugins: [icons()], static: true })

      expect(file.mock.calls.filter(([path]) => String(path).endsWith('src/icons/logo.svg'))).toHaveLength(1)
    }
    finally {
      file.mockRestore()
    }
  })

  it('adds the folders named in dirs beside local', async () => {
    const root = linkedApp({ ...page('~icons/local/logo', '~icons/brand/mark'), 'src/icons/logo.svg': LOGO, 'assets/brand/mark.svg': '<svg viewBox="0 0 8 8"><rect/></svg>' })
    await build({ root, plugins: [icons({ dirs: { brand: 'assets/brand' } })], static: true })

    expect(html(root)).toContain('<rect/>')
    expect(html(root)).toContain('M0 0h32')
  })

  it('renames local when dirs names src/icons', async () => {
    const root = linkedApp({ ...page('~icons/local/logo'), 'src/icons/logo.svg': LOGO })

    await expect(build({ root, plugins: [icons({ dirs: { app: 'src/icons' } })], static: true })).rejects.toThrow('no icon set "local" is installed')
  })

  it('leaves local to icons({ sets }) when it holds a set of that name', async () => {
    const root = linkedApp({ ...page('~icons/local/arrow'), 'src/icons/logo.svg': LOGO })
    await build({ root, plugins: [icons({ sets: { local: { ...DEMO, prefix: 'local' } } })], static: true })

    expect(html(root)).toContain('M5 12h14')
  })

  it('reads a file edited since the last build, as kay dev rebuilds', async () => {
    const root = linkedApp({ ...page('~icons/local/logo'), 'src/icons/logo.svg': LOGO })
    const plugin = icons()
    await build({ root, plugins: [plugin], static: true })
    writeFileSync(join(root, 'src/icons/logo.svg'), '<svg viewBox="0 0 16 16"><circle r="2"/></svg>')
    await build({ root, plugins: [plugin], static: true })

    expect(html(root)).toContain('<circle r="2"/>')
    expect(plugin.watchPaths).toBeFunction()
    expect((plugin.watchPaths as (root: string) => string[])(root)).toEqual([join(root, 'src/icons')])
  })

  it('fails the build on an unusable file, naming it and its importer', async () => {
    const root = linkedApp({ ...page('~icons/local/logo'), 'src/icons/logo.svg': '<svg><path d="M0 0h32"/></svg>' })

    await expect(build({ root, plugins: [icons()], static: true }))
      .rejects.toThrow('@kayjs/icons: src/icons/logo.svg, imported by src/routes/index.tsx, has no viewBox, nor a width and height, to size it: add viewBox="0 0 <width> <height>" to its <svg>.')
  })

  it('fails kay check once on an unusable file, at the file rather than its imports', async () => {
    const root = linkedApp({
      ...page('~icons/local/logo'),
      'src/icons/logo.svg': '<svg><path d="M0 0h32"/></svg>',
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons()] }\n`,
    })

    expect((await checkProject(root, { skipTypecheck: true })).errors.filter(error => error.includes('@kayjs/icons')))
      .toEqual(['src/icons/logo.svg:1:1: error: @kayjs/icons: this file has no viewBox, nor a width and height, to size it: add viewBox="0 0 <width> <height>" to its <svg>.'])
  })

  it('fails kay check on a dirs folder that does not exist or a prefix that is no set name', async () => {
    const root = linkedApp({ 'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ dirs: { brand: 'assets/brand', Logos: 'src/icons' } })] }\n`, 'src/icons/logo.svg': LOGO })

    expect((await checkProject(root, { skipTypecheck: true })).errors.filter(error => error.includes('@kayjs/icons'))).toEqual([
      'kay.config.ts:1:1: error: @kayjs/icons: icons({ dirs }) reads the set "brand" from assets/brand, which does not exist.',
      'kay.config.ts:1:1: error: @kayjs/icons: "Logos" in icons({ dirs }) is not an icon set name: name it in lowercase words joined by dashes, such as brand.',
    ])
  })
})

describe('an icon or set that does not exist', () => {
  const page = (specifier: string): Record<string, string> => ({
    'src/routes/index.tsx': `import { Icon } from '@kayjs/icons'\nimport arrow from '${specifier}'\nexport default function Home() { return <main><Icon icon={arrow} /></main> }\n`,
  })

  it('fails the build naming the importing file and the closest icons', async () => {
    const root = linkedApp(page('~icons/demo/arow'))

    await expect(build({ root, plugins: [icons({ sets: { demo: DEMO } })], static: true }))
      .rejects.toThrow('@kayjs/icons: no icon "arow" in set "demo", imported by src/routes/index.tsx. Did you mean ~icons/demo/arrow? Search with kay icons-find <words>.')
  })

  it('fails kay check at the import, naming the closest icons', async () => {
    const root = linkedApp({
      ...page('~icons/demo/arow'),
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ sets: { demo: ${JSON.stringify(DEMO)} } })] }\n`,
    })

    expect((await checkProject(root, { skipTypecheck: true })).errors)
      .toContain('src/routes/index.tsx:2:19: error: @kayjs/icons: no icon "arow" in set "demo". Did you mean ~icons/demo/arrow? Search with kay icons-find <words>.')
  })

  it('fails kay check on a set that is not installed, naming the closest installed set', async () => {
    const root = linkedApp({
      ...page('~icons/dmeo/arrow'),
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ sets: { demo: ${JSON.stringify(DEMO)} } })] }\n`,
    })

    expect((await checkProject(root, { skipTypecheck: true })).errors)
      .toContain('src/routes/index.tsx:2:19: error: @kayjs/icons: no icon set "dmeo" is installed. Did you mean ~icons/demo/arrow? Otherwise install @iconify-json/dmeo, or add it to icons({ sets }) or icons({ dirs }).')
  })

  it('suggests no other set when the closest one lacks the icon', async () => {
    const root = linkedApp({
      ...page('~icons/dmeo/nope'),
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ sets: { demo: ${JSON.stringify(DEMO)} } })] }\n`,
    })

    expect((await checkProject(root, { skipTypecheck: true })).errors)
      .toContain('src/routes/index.tsx:2:19: error: @kayjs/icons: no icon set "dmeo" is installed. Otherwise install @iconify-json/dmeo, or add it to icons({ sets }) or icons({ dirs }).')
  })

  it('explains the specifier shape when the set part is not a set name', async () => {
    const root = linkedApp({
      ...page('~icons/Demo/arrow'),
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ sets: { demo: ${JSON.stringify(DEMO)} } })] }\n`,
    })

    expect((await checkProject(root, { skipTypecheck: true })).errors)
      .toContain('src/routes/index.tsx:2:19: error: @kayjs/icons: "Demo" is not an icon set name: write ~icons/<set>/<name>, such as ~icons/tabler/home.')
  })

  it('passes kay check when every imported icon exists', async () => {
    const root = linkedApp({
      ...page('~icons/demo/arrow'),
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ sets: { demo: ${JSON.stringify(DEMO)} } })] }\n`,
    })

    expect((await checkProject(root, { skipTypecheck: true })).errors.filter(error => error.includes('@kayjs/icons'))).toEqual([])
  })

  it('checks only real imports, not an import spelled in a string, a template or a comment (#3618)', async () => {
    const root = linkedApp({
      'src/snippets.ts': [
        '// copy: import x from \'~icons/demo/arow\'',
        'export const quoted = "import x from \'~icons/demo/nope\'"',
        'export function snippet(set: string, name: string): string { return `import x from \'~icons/${set}/${name}\'` }',
        'export const lazy = (): Promise<unknown> => import(\'~icons/demo/gone\')',
        '',
      ].join('\n'),
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ sets: { demo: ${JSON.stringify(DEMO)} } })] }\n`,
    })

    expect((await checkProject(root, { skipTypecheck: true })).errors.filter(error => error.includes('@kayjs/icons')))
      .toEqual(['src/snippets.ts:4:52: error: @kayjs/icons: no icon "gone" in set "demo". Search with kay icons-find <words>.'])
  })
})

describe('the type of an ~icons import', () => {
  it('comes with registering icons(), so an app declares no module', async () => {
    const root = linkedApp({
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, jsx: 'react-jsx', jsxImportSource: '@kayjs/kay' }, include: ['src', 'kay.config.ts'] }),
      'kay.config.ts': `import { icons } from '@kayjs/icons/plugin'\nexport default { plugins: [icons({ sets: { demo: ${JSON.stringify(DEMO)} } })] }\n`,
      'src/size.ts': `import arrow from '~icons/demo/arrow'\nexport const width: string = arrow.width\n`,
    })

    expect((await checkProject(root)).errors.filter(error => error.includes('src/size.ts'))).toEqual([])
  })
})

describe('@kayjs/icons/search in an island', () => {
  it('warns at build that the island ships the word table, naming the file', async () => {
    const root = linkedApp({
      'src/Picker.tsx': `
        import { signal } from '@kayjs/kay'
        import { findIcons } from '@kayjs/icons/search'
        export function Picker() {
          const query = signal('')
          return <input value={query.value} onInput={e => { query.value = e.currentTarget.value }} title={findIcons(['home'], query.value).join(' ')} />
        }
      `,
      'src/routes/index.tsx': `import { Picker } from '../Picker'\nexport default function Home() { return <main><Picker /></main> }`,
    })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await build({ root, plugins: [icons()], static: true })

      expect(warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('@kayjs/icons'))).toEqual(['@kayjs/icons: src/Picker.tsx imports @kayjs/icons/search into an island, which ships its 1.7 MB word table to the browser. Search on the server instead, in a route or an action.'])
    }
    finally {
      warn.mockRestore()
    }
  })
})
