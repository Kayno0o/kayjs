import type { IconSet } from '../../plugin-icons/src/index'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { icons } from '../../plugin-icons/src/plugin'
import { build } from '../src/build/index'
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
