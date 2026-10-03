import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'

interface ClientModule {
  mount: (element: HTMLElement) => () => void
  selectionRows: (initial?: number) => {
    selected: { (): number | undefined, set: (key: number | undefined | ((current: number | undefined) => number | undefined)) => void, is: (key: number) => boolean }
    runs: number[]
    dispose: () => void
    flush: () => void
  }
}

let outdir: string
let client: ClientModule

// Lets Solid's staged writes and effects land before the DOM is read.
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeAll(async () => {
  GlobalRegistrator.register()
  outdir = await mkdtemp(join(tmpdir(), 'kay-dom-'))
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, 'fixtures/app/src/client.ts')],
    outdir,
    target: 'browser',
    plugins: [kay()],
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  client = await import(build.outputs[0]!.path) as ClientModule
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(outdir, { recursive: true, force: true })
})

describe('selection', () => {
  it('re-runs only the rows a change selects or unselects', () => {
    const { selected, runs, dispose, flush } = client.selectionRows(3)
    const ranAgain = (before: number[]) => runs.flatMap((count, row) => count === before[row] ? [] : [row])

    expect(runs.every(count => count === 1)).toBe(true)

    let before = [...runs]

    selected.set(5)
    flush()
    expect(ranAgain(before)).toEqual([3, 5])

    before = [...runs]
    selected.set(current => (current ?? 0) + 2)
    flush()
    expect(ranAgain(before)).toEqual([5, 7])
    expect(selected()).toBe(7)

    before = [...runs]
    selected.set(7)
    selected.set(undefined)
    flush()
    expect(ranAgain(before)).toEqual([7])
    // Read outside any tracking scope, as in an event handler.
    expect(selected.is(7)).toBe(false)
    dispose()
  })
})

describe('client bundle', () => {
  it('renders and reacts to input through bind:value', async () => {
    const root = document.createElement('div')

    document.body.append(root)
    const dispose = client.mount(root)

    expect(root.querySelectorAll('li.todo')).toHaveLength(2)

    const input = root.querySelector<HTMLInputElement>('input[type=search]')!

    input.value = 'Ship'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect([...root.querySelectorAll('li.todo span')].map(span => span.textContent)).toEqual(['1. Ship it'])

    input.value = 'nothing'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(root.querySelector('li.empty')?.textContent).toBe('Nothing matches')
    dispose()
  })

  it('narrows an aliased if once its value appears', async () => {
    const root = document.createElement('div')

    document.body.append(root)
    const dispose = client.mount(root)

    expect(root.querySelector('p strong')).toBeNull()
    root.querySelector<HTMLInputElement>('li.todo input[type=checkbox]')!.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(root.querySelector('p strong')?.textContent).toBe('Write the compiler')
    expect([...root.querySelectorAll('li.todo')].map(li => li.classList.contains('selected'))).toEqual([true, false])
    root.querySelectorAll<HTMLInputElement>('li.todo input[type=checkbox]')[1]!.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect([...root.querySelectorAll('li.todo')].map(li => li.classList.contains('selected'))).toEqual([false, true])
    dispose()
  })
})
