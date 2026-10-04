import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The fixture is an app installing the library, linked back to this repository by scripts/link-fixture.ts.
const ROOT = join(import.meta.dir, '..')
const site = await testSite({ root: ROOT })

// The element with that id, as rendered.
async function element(path: string, id: string): Promise<string> {
  const html = (await site.visit(path)).html
  const start = html.indexOf(` id="${id}"`)

  expect(start).toBeGreaterThan(-1)

  const open = html.lastIndexOf('<', start)
  const tag = (/^<([a-z]+)/).exec(html.slice(open))![1]!

  return html.slice(open, html.indexOf(`</${tag}>`, start) + tag.length + 3)
}

test('kay check passes on the fixture, the library\'s components it renders and this test included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toBe('')
  expect(await check.exited).toBe(0)
}, 60_000)

describe('Icon', () => {
  test('draws a slot through the app\'s settings, which replaced the close icon and kept the rest', async () => {
    expect(await element('/buttons', 'slot')).toContain('m7-2l4 4m0-4l-4 4')
    expect(await element('/buttons', 'accent')).toContain('M12 5v14m-7-7h14')
  })

  test('is decorative unless labelled', async () => {
    expect(await element('/buttons', 'slot')).toContain('aria-hidden="true"')
    expect(await element('/buttons', 'own')).toContain('role="img" aria-label="Home"')
  })
})

describe('Button', () => {
  test('is a button that submits nothing unless asked, with its variant as a class', async () => {
    expect(await element('/buttons', 'plain')).toBe('<button id="plain" type="button" class="btn">Save</button>')
    expect(await element('/buttons', 'accent')).toMatch(/^<button id="accent" type="submit" class="btn btn-accent"><svg[^>]*class="icon">.*<\/svg>Add<\/button>$/)
  })

  test('spins in place of its icon while busy', async () => {
    expect(await element('/buttons', 'busy')).toMatch(/aria-busy="true".*class="icon spinner"/)
  })
})

test('IconButton names its action for screen readers and as its tooltip', async () => {
  expect(await element('/buttons', 'delete')).toMatch(/^<button id="delete" type="button" aria-label="Delete" data-tooltip="Delete" data-size="sm" data-variant="danger" class="icon-btn shell shell-danger">/)
})

test('Toaster is an island rendering an empty manual popover, filled in the browser only', async () => {
  expect(await element('/buttons', 'toasts')).toMatch(/^<div id="toasts"><slot data-component="[^"]*\/toaster\.kay"[^>]*><div class="toaster" popover="manual"><\/div>/)
})
