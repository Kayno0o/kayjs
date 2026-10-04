import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { transform } from '../src/build/solid-compiler'

// Each test reproduces a Solid 2 bug kay works around, and fails once a Solid release fixes it: the workaround its name points at can then go.
const SSR_MARKER = /<!--\$-->/g
const DOM_MARKER = /<!\$>/g
const FUNCTION_ITEMS = `import { render } from '@solidjs/web'
import { createComponent, createSignal, flush, For } from 'solid-js'

export function run(element: HTMLElement) {
  const [list, setList] = createSignal<(() => string)[]>([() => 'first'])

  render(() => createComponent(For, {
    get each() {
      return list()
    },
    keyed: false,
    children: (item: () => unknown) => () => {
      const value = item()

      return typeof value === 'function' ? value() : \`called:\${String(value)}\`
    },
  } as never), element)
  flush()
  setList([() => 'second'])
  flush()

  return element.textContent
}
`

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('Solid 2 bugs kay works around', () => {
  it('folds a constant child into the server markup the browser build inserts between markers; drop the IIFE wrap in src/compiler/rewrite.ts once this fails', () => {
    const tsx = 'const name = \'Ada\'\nconst tag = `t${name}`\nexport default (props: { n: number }) => <p>{props.n}{name}{tag}{props.n}</p>\n'
    const server = transform(tsx, { filename: 'fold.tsx', generate: 'ssr', hydratable: true }).code
    const browser = transform(tsx, { filename: 'fold.tsx', generate: 'dom', hydratable: true }).code

    expect(server.match(SSR_MARKER)).toHaveLength(2)
    expect(browser.match(DOM_MARKER)).toHaveLength(4)
  })

  it('calls a function item of a positional For as an updater; drop the boxing in src/runtime/loop.ts once this fails', async () => {
    const dir = await mkdtemp(join(import.meta.dir, '.canary-'))

    try {
      await Bun.write(join(dir, 'entry.ts'), FUNCTION_ITEMS)
      const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: join(dir, 'out'), target: 'browser' })

      if (!build.success)
        throw new AggregateError(build.logs, 'canary build failed')

      const { run } = await import(build.outputs[0]!.path) as { run: (element: HTMLElement) => string }

      expect(run(document.createElement('div'))).toBe('called:second')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
