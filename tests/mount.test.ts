import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mountComponent, readPersisted, settle, writePersisted } from '../src/test'
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
    const { root, unmount } = await mountComponent('tests/fixtures/mount/toggle.kay', { label: 'Menu', onChange: (open: boolean) => changes.push(open), onDispose: () => disposed = true })

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
    const { root, unmount } = await mountComponent('tests/fixtures/mount/refused.kay', { onFocused: (took: boolean) => focused.push(took) })

    root.querySelector<HTMLButtonElement>('.save')!.click()
    await answered(focused)

    expect(focused).toEqual([true])
    expect(document.activeElement).toBe(root.querySelector('.login'))
    unmount()
  })

  it('reveals an invalid field hidden until found as find-in-page does, innermost first, a closed details opened, then focuses it', async () => {
    const focused: boolean[] = []
    const matched: string[] = []
    const { root, unmount } = await mountComponent('tests/fixtures/mount/until-found.kay', { onFocused: (took: boolean) => focused.push(took) })

    root.addEventListener('beforematch', event => matched.push((event.target as Element).className))
    root.querySelector<HTMLButtonElement>('.save')!.click()
    await answered(focused)

    expect(matched).toEqual(['inner', 'outer'])
    expect(root.querySelectorAll('[hidden]')).toHaveLength(0)
    expect(root.querySelector('details')!.open).toBe(true)
    expect(focused).toEqual([true])
    expect(document.activeElement).toBe(root.querySelector('.code'))

    // Shown now, in a details left open: nothing to reveal again.
    root.querySelector<HTMLButtonElement>('.save')!.click()
    await answered(focused, 2)

    expect(matched).toEqual(['inner', 'outer'])
    expect(focused).toEqual([true, true])
    unmount()
  })

  it('stops revealing where a beforematch listener hides the element again, shows it itself or opens a details above it, as the spec does', async () => {
    const focused: boolean[] = []
    const { root, unmount } = await mountComponent('tests/fixtures/mount/until-found.kay', { onFocused: (took: boolean) => focused.push(took) })

    root.addEventListener('beforematch', event => (event.target as Element).setAttribute('hidden', ''))
    root.querySelector<HTMLButtonElement>('.save')!.click()
    await answered(focused)

    expect(root.querySelector('.inner')!.getAttribute('hidden')).toBe('')
    expect(root.querySelector('details')!.open).toBe(false)
    expect(root.querySelector('.outer')!.getAttribute('hidden')).toBe('until-found')
    unmount()

    // A tab list showing its panel on the event: the panels around it stay as they are.
    const shown = await mountComponent('tests/fixtures/mount/until-found.kay', { onFocused: (took: boolean) => focused.push(took) })

    shown.root.addEventListener('beforematch', event => (event.target as Element).removeAttribute('hidden'))
    shown.root.querySelector<HTMLButtonElement>('.save')!.click()
    await answered(focused, 2)

    expect(shown.root.querySelector('.inner')!.hasAttribute('hidden')).toBe(false)
    expect(shown.root.querySelector('details')!.open).toBe(false)
    expect(shown.root.querySelector('.outer')!.getAttribute('hidden')).toBe('until-found')
    shown.unmount()

    // An accordion opening its own section: the details found open ends the reveal, the panel around it left hidden.
    const opened = await mountComponent('tests/fixtures/mount/until-found.kay', { onFocused: (took: boolean) => focused.push(took) })

    opened.root.addEventListener('beforematch', (event) => {
      const details = (event.target as Element).closest('details')

      if (details)
        details.open = true
    })
    opened.root.querySelector<HTMLButtonElement>('.save')!.click()
    await answered(focused, 3)

    expect(opened.root.querySelector('.inner')!.hasAttribute('hidden')).toBe(false)
    expect(opened.root.querySelector('details')!.open).toBe(true)
    expect(opened.root.querySelector('.outer')!.getAttribute('hidden')).toBe('until-found')
    opened.unmount()
  })

  it('focuses the field as it is when the reveal fails to load, as a chunk a deploy replaced does', async () => {
    // A process of its own, as the reveal this file loaded already stays loaded.
    const child = Bun.spawn([process.execPath, 'tests/fixtures/mount/reveal-fails.ts'], { stdout: 'pipe', stderr: 'pipe' })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect({ code, errors }).toEqual({ code: 0, errors: '' })
    expect(JSON.parse(output)).toEqual({ focused: true, open: false })
  })

  it('mounts a component that calls an API module, which the browser build knows only by where it is served', async () => {
    const saved = process.env.KAY_ROOT
    const asked: string[] = []
    const stub = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${init?.method} ${new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname}`)

      return Response.json({ title: 'Milk' })
    }) as typeof fetch)

    process.env.KAY_ROOT = join(import.meta.dir, 'fixtures/mount-api')

    try {
      const { root, unmount } = await mountComponent('src/components/add-note.kay')

      root.querySelector('button')!.click()

      for (let tries = 0; root.querySelector('.added')?.textContent === '' && tries < 200; tries++)
        await Bun.sleep(5)

      expect(asked).toEqual(['POST /api/notes'])
      expect(root.querySelector('.added')?.textContent).toBe('{"title":"Milk"}')
      unmount()
    }
    finally {
      stub.mockRestore()

      if (saved === undefined)
        delete process.env.KAY_ROOT
      else
        process.env.KAY_ROOT = saved
    }
  })

  it('reveals nothing for a field that cannot take focus', async () => {
    const focused: boolean[] = []
    const matched: string[] = []
    const { root, unmount } = await mountComponent('tests/fixtures/mount/reveal-skips.kay', { onFocused: (took: boolean) => focused.push(took) })

    root.addEventListener('beforematch', event => matched.push((event.target as Element).className))
    root.querySelector<HTMLButtonElement>('.save')!.click()
    await answered(focused)

    expect(matched).toEqual([])
    expect(root.querySelector('.skipped')!.getAttribute('hidden')).toBe('until-found')
    unmount()
  })

  it('runs every mount on modules of its own, as a page load does, a persisted signal reading storage as it is then, which a test writes and reads as it keeps it', async () => {
    try {
      writePersisted('favorites', ['first'])

      const first = await mountComponent('tests/fixtures/mount/favorites.kay')

      expect(first.root.querySelector('.favorites')!.textContent).toBe('first')
      first.unmount()

      writePersisted('favorites', ['second'])

      const second = await mountComponent('tests/fixtures/mount/favorites.kay')

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

  it('shares only kay\'s own safe-html module with the test process, not any module of that name', async () => {
    const { root, unmount } = await mountComponent('tests/fixtures/mount/own-safe-html.kay')

    expect(root.querySelector('.own')!.textContent).toBe('its own copy')
    unmount()
  })

  it('reports a component that does not compile, and builds it again once fixed', async () => {
    const dir = await scratchDir('mount-')
    const file = join(dir, 'broken.kay')

    try {
      await Bun.write(file, 'p {\n')
      await expect(mountComponent(file)).rejects.toThrow('kay: bundling')

      await Bun.write(file, 'p.fixed Fixed\n')

      const { root, unmount } = await mountComponent(file)

      expect(root.innerHTML).toBe('<p class="fixed">Fixed</p>')
      unmount()
      unmount()
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Until the island's `focusInvalid()` answered, which may load the reveal first.
async function answered(focused: boolean[], count = 1): Promise<void> {
  for (let tries = 0; focused.length < count && tries < 200; tries++)
    await Bun.sleep(5)
}
