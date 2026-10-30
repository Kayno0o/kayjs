import { resolve } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { registerLoader } from '../src/server/loader'
import { mountComponent, settle } from '../src/test'
import { registry } from './fixtures/mount/shared/registry'
import { count } from './fixtures/mount/shared/store'

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function imported(name: string): Promise<(props: Record<string, unknown>) => unknown> {
  await registerLoader(process.cwd())

  return ((await import(resolve('tests/fixtures/mount/shared', name))) as { default: (props: Record<string, unknown>) => unknown }).default
}

describe('a mounted component and the modules it imports', () => {
  it('statically imports the module instance the test imports', async () => {
    registry.clicks = 5

    const { root, unmount } = await mountComponent(await imported('static.kay'))

    expect(root.querySelector('.clicks')!.textContent).toBe('5')
    root.querySelector<HTMLButtonElement>('.bump')!.click()
    await settle()
    expect(registry.clicks).toBe(6)
    expect(root.querySelector('.clicks')!.textContent).toBe('6')
    unmount()
  })

  it('shares that module across two mounts of one file', async () => {
    registry.clicks = 0

    const first = await mountComponent(await imported('static.kay'))
    const second = await mountComponent(await imported('static.kay'))

    first.root.querySelector<HTMLButtonElement>('.bump')!.click()
    await settle()
    expect(registry.clicks).toBe(1)
    second.root.querySelector<HTMLButtonElement>('.bump')!.click()
    await settle()
    expect(registry.clicks).toBe(2)
    first.unmount()
    second.unmount()
  })

  it('shares it with a child component importing the same module', async () => {
    registry.clicks = 7

    const { root, unmount } = await mountComponent(await imported('parent.kay'))

    expect(root.querySelector('.child')!.textContent).toBe('7')
    unmount()
  })

  it('reaches a dynamic import through mock.module before the mount', async () => {
    await mock.module('./fixtures/mount/shared/lazy', () => ({ name: 'mocked' }))

    const { root, unmount } = await mountComponent(await imported('dynamic.kay'))

    root.querySelector<HTMLButtonElement>('.load')!.click()
    await settle()
    await settle()
    expect(root.querySelector('.loaded')!.textContent).toBe('mocked')
    unmount()
  })

  it('reaches a package import through mock.module before the mount', async () => {
    await mock.module('ms', () => ({ default: () => 'mocked ms' }))

    const { root, unmount } = await mountComponent(await imported('package.kay'))

    expect(root.querySelector('.ms')!.textContent).toBe('mocked ms')
    unmount()
  })

  it('keeps a module that imports kay, such as a signal store, fresh for each mount', async () => {
    count.set(10)

    const first = await mountComponent(await imported('store.kay'))

    first.root.querySelector<HTMLButtonElement>('.inc')!.click()
    await settle()
    expect(first.root.querySelector('.count')!.textContent).toBe('1')
    first.unmount()

    const second = await mountComponent(await imported('store.kay'))

    expect(second.root.querySelector('.count')!.textContent).toBe('0')
    second.unmount()
  })
})
