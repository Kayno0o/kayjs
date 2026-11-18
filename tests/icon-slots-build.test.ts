import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { loadConfig } from '../src/config-loader'
import { clientOptionsOf } from '../src/project'
import { fixtureCopy } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

const DIALOG = '---\nimport { signal } from \'kay\'\nimport Dialog from \'@kayjs/ui/dialog.kay\'\nconst open = signal(false)\n---\nbutton(onClick={() => open.set(true)}) Open\nDialog(open={open()} title="Hi" onOpenChange={({ open: o }) => open.set(o)})\n  p Hello\n'
const DRAWN = '---\nimport Icon from \'@kayjs/ui/icon.kay\'\nimport { signal } from \'kay\'\nconst name = signal(\'plus\')\n---\nbutton(onClick={() => name.set(\'zoomFit\')}) Next\nIcon(icon={name()})\n'

// The text of every chunk an island ships, from a copy of the list fixture with only the given components.
async function shipped(components: Record<string, string>): Promise<string> {
  const root = resolve(await fixtureCopy('ui-list'))

  dirs.push(root)
  // An app declares kayjs-ui and its icon set, which is how the build follows the library's files.
  await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'icon-slots', private: true, dependencies: { 'kay': '*', '@kayjs/ui': '*', '@iconify-json/tabler': '*' } }))
  await Promise.all(['src/components', 'src/routes'].map(async dir => rm(join(root, dir), { recursive: true, force: true })))
  await Promise.all(Object.entries(components).map(async ([name, text]) => Bun.write(join(root, `src/components/${name.toLowerCase()}.kay`), text)))
  await Bun.write(join(root, 'src/routes/index.kay'), `---\n${Object.keys(components).map(name => `import ${name} from '../components/${name.toLowerCase()}.kay'`).join('\n')}\n---\nh1 Page\n${Object.keys(components).join('\n')}\n`)

  const client = await buildClient(root, clientOptionsOf(await loadConfig(root), { dev: false, underKayDev: false }))

  // A closed dialog's code loads when it opens, in a chunk no island lists: every script of the build counts.
  const chunks = await Array.fromAsync(new Bun.Glob('**/*.js').scan(client.dir))

  return (await Promise.all(chunks.map(async chunk => Bun.file(join(client.dir, chunk)).text()))).join('\n')
}

// A path of the `zoomFit` icon of the default set, a slot no file a Dialog reaches writes.
const ZOOM_FIT = 'M3.268 12.043A7.02'
const CLOSE = 'M18 6L6 18M6 6l12 12'

describe('the icons an island ships', () => {
  it('holds the slots the project writes, and the whole registry once a slot is computed', async () => {
    const dialog = await shipped({ Dialog: DIALOG })

    expect(dialog).toContain(CLOSE)
    expect(dialog).not.toContain(ZOOM_FIT)

    const computed = await shipped({ Dialog: DIALOG, Drawn: DRAWN })

    expect(computed).toContain(CLOSE)
    expect(computed).toContain(ZOOM_FIT)
  }, 120_000)
})
