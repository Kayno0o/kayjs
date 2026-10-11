import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mount, readPersisted, settle, writePersisted } from '../src/test'
import { scratchDir } from './scratch'

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

  it('focuses the first invalid field a write just revealed, its render flushed first', async () => {
    const focused: boolean[] = []
    const { root, unmount } = await mount('tests/fixtures/mount/refused.kay', { onFocused: (took: boolean) => focused.push(took) })

    root.querySelector<HTMLButtonElement>('.save')!.click()

    expect(focused).toEqual([true])
    expect(document.activeElement).toBe(root.querySelector('.login'))
    unmount()
  })

  it('runs every mount on modules of its own, as a page load does, a persisted signal reading storage as it is then, which a test writes and reads as it keeps it', async () => {
    try {
      writePersisted('favorites', ['first'])

      const first = await mount('tests/fixtures/mount/favorites.kay')

      expect(first.root.querySelector('.favorites')!.textContent).toBe('first')
      first.unmount()

      writePersisted('favorites', ['second'])

      const second = await mount('tests/fixtures/mount/favorites.kay')

      expect(second.root.querySelector('.favorites')!.textContent).toBe('second')
      second.root.querySelector('button')!.click()
      await settle()

      expect(readPersisted('favorites')).toEqual(['second', 'added'])
      expect(localStorage.getItem('favorites')).not.toBe(JSON.stringify(['second', 'added']))
      expect(readPersisted('nothing')).toBeUndefined()
      second.unmount()
    }
    finally {
      localStorage.clear()
    }
  })

  it('reports a component that does not compile, and builds it again once fixed', async () => {
    const dir = await scratchDir('mount-')
    const file = join(dir, 'broken.kay')

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
      await rm(dir, { recursive: true, force: true })
    }
  })
})
