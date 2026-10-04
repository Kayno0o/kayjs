import { rm } from 'node:fs/promises'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mount, settle } from '../src/test'

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('mount', () => {
  it('renders a component built for the browser, runs its handlers and effects, and disposes of it', async () => {
    const changes: boolean[] = []
    let disposed = false
    const { root, unmount } = await mount('tests/fixtures/mount/toggle.kay', { label: 'Menu', onChange: (open: boolean) => changes.push(open), onDispose: () => disposed = true })

    expect(root.innerHTML).toContain('<button class="toggle">Menu</button>')
    expect(root.querySelector('.panel')).toBeNull()

    root.querySelector('button')!.click()
    await settle()

    expect(root.querySelector('.panel')?.textContent).toBe('Open')
    expect(changes).toEqual([false, true])

    unmount()

    expect(disposed).toBe(true)
    expect(root.isConnected).toBe(false)
  })

  it('reports a component that does not compile, and builds it again once fixed', async () => {
    const file = 'tests/fixtures/mount/.broken.kay'

    try {
      await Bun.write(file, 'p {\n')
      await expect(mount(file)).rejects.toThrow('kay: bundling')

      await Bun.write(file, 'p.fixed Fixed\n')

      const { root, unmount } = await mount(file)

      expect(root.innerHTML).toBe('<p class="fixed">Fixed</p>')
      unmount()
      unmount()
    }
    finally {
      await rm(file, { force: true })
    }
  })
})
