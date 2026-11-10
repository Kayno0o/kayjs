import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Driven from '../tests/fixture/src/components/navigation-progress-driven.kay'
import { library } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const root = () => mounted!.root.querySelector('.kui-navigation-progress') as HTMLElement

async function mount(props: Record<string, unknown>) {
  mounted = await mountComponent(await library('navigation-progress'), props)
}

test('the bar is hidden and out of the accessibility tree until a wait outlasts the delay', async () => {
  await mount({ pending: false })
  expect([root().hidden, root().getAttribute('aria-hidden')]).toEqual([true, 'true'])
})

test('a wait shows the bar after the delay and its end hides it, each heard once', async () => {
  const heard: string[] = []

  await mount({ pending: false, delay: '20ms', onShow: () => heard.push('show'), onHide: () => heard.push('hide') })
  await mounted!.setProps({ pending: true })
  expect(root().hidden).toBe(true)
  await Bun.sleep(60)
  await settle()
  expect([root().hidden, heard]).toEqual([false, ['show']])
  await mounted!.setProps({ pending: false })
  await settle()
  expect([root().hidden, heard]).toEqual([true, ['show', 'hide']])
})

test('a wait that ends inside the delay never shows the bar, and onHide is not called for it', async () => {
  const heard: string[] = []

  await mount({ pending: false, delay: '40ms', onShow: () => heard.push('show'), onHide: () => heard.push('hide') })
  await mounted!.setProps({ pending: true })
  await mounted!.setProps({ pending: false })
  await Bun.sleep(80)
  await settle()
  expect([root().hidden, heard]).toEqual([true, []])
})

test('tone colours the bar and a bare bar is the accent', async () => {
  await mount({ pending: true })
  expect(mounted!.root.querySelector('[data-part=bar]')!.classList.contains('bg-accent')).toBe(true)
  mounted?.unmount()
  await mount({ pending: true, tone: 'danger' })
  expect(mounted!.root.querySelector('[data-part=bar]')!.classList.contains('bg-danger')).toBe(true)
})

// The swap's own hook, which `navigation.pending()` follows: `loading` while a page is fetched, `idle` once it is in place. The fixture's component exposes it from the bundle's own copy of the runtime.
async function swap(state: 'loading' | 'swapping' | 'idle') {
  ;(window as unknown as { driveSwap: (state: string) => void }).driveSwap(state)
  await settle()
}

async function mountDriven(props: Record<string, unknown>) {
  mounted = await mountComponent(Driven, props)
}

test('with no pending prop the bar follows the page swap: it shows after the delay, hides when the swap ends, and onShow and onHide hear it', async () => {
  const heard: string[] = []

  await mountDriven({ delay: '20ms', onShow: () => heard.push('show'), onHide: () => heard.push('hide') })
  await swap('loading')
  expect([root().hidden, heard]).toEqual([true, []])
  await Bun.sleep(60)
  await settle()
  expect([root().hidden, heard]).toEqual([false, ['show']])
  await swap('swapping')
  expect(root().hidden).toBe(false)
  await swap('idle')
  expect([root().hidden, heard]).toEqual([true, ['show', 'hide']])
})

test('a swap that ends before the delay shows nothing', async () => {
  const heard: string[] = []

  await mountDriven({ delay: '40ms', onShow: () => heard.push('show'), onHide: () => heard.push('hide') })
  await swap('loading')
  await swap('idle')
  await Bun.sleep(80)
  await settle()
  expect([root().hidden, heard]).toEqual([true, []])
})
