import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { uiItems } from '../src/check/ui-items'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('ui-items-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const HEAD = '---\nimport Timeline from \'@kaynooo/kayjs-ui/timeline.kay\'\nimport Accordion from \'@kaynooo/kayjs-ui/accordion.kay\'\nimport AppSwitcher from \'@kaynooo/kayjs-ui/app-switcher.kay\'\nimport AudioPlayer from \'@kaynooo/kayjs-ui/audio-player.kay\'\nimport MediaGallery from \'@kaynooo/kayjs-ui/media-gallery.kay\'\n'

describe('deprecated-ui-items', () => {
  it('renames the keys of a literal list, one bound to a const, and a shorthand', async () => {
    const page = `${HEAD}const text = 'Opened'\nconst sections = [{ value: 'a', title: 'A' }] as const\n---\nTimeline(label="Day" entries={[{ key: 'a', time: '08:30', text }]})\nAccordion(items={sections} panel={() => null})\nAccordion(items={[{ value: 'b', title: 'B', open: true }]} panel={() => null})\nAppSwitcher(apps={[{ id: 'x', href: '/', label: 'X' }]})\nAudioPlayer(src="/a.mp3" chapters={[{ title: 'One', start: 0, url: '/one' }]})\nMediaGallery(items={[{ key: 1, kind: 'image', thumb: 't', preview: 'p', title: 'Sea' }]})\n`
    const root = await project({ 'src/routes/page.kay': page })

    try {
      const found = await uiItems(root, {})

      expect(found).toHaveLength(9)
      expect(found.every(one => one.code === 'deprecated-ui-items' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)

      const fixed = await Bun.file(join(root, 'src/routes/page.kay')).text()

      expect(fixed).toContain('Timeline(label="Day" entries={[{ key: \'a\', time: \'08:30\', label: text }]})')
      expect(fixed).toContain('const sections = [{ key: \'a\', label: \'A\' }] as const')
      expect(fixed).toContain('Accordion(items={[{ key: \'b\', label: \'B\', open: true }]}')
      expect(fixed).toContain('apps={[{ key: \'x\', href: \'/\', label: \'X\' }]}')
      expect(fixed).toContain('chapters={[{ label: \'One\', start: 0, href: \'/one\' }]}')
      expect(fixed).toContain('preview: \'p\', label: \'Sea\' }]}')
      expect(await uiItems(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an item holding the new key with no fix, and leaves other lists, components and files alone', async () => {
    const both = `${HEAD}---\nTimeline(label="Day" entries={[{ key: 'a', time: '1', text: 'Old', label: 'New' }]})\n`
    const other = `${HEAD}---\nMenu(items={[{ value: 'a', title: 'A' }]})\nTimeline(label="Day" entries={entries})\nAccordion(items={items.map(one => ({ value: one, title: one }))} panel={() => null})\n`
    const unrelated = '---\nimport Timeline from \'./timeline.kay\'\n---\nTimeline(entries={[{ key: \'a\', time: \'1\', text: \'Old\' }]})\n'
    const local = '---\nimport Toast from \'@kaynooo/kayjs-ui/toaster.kay\'\nimport Timeline from \'./timeline.kay\'\n---\nTimeline(entries={[{ key: \'a\', time: \'1\', text: \'Mine\' }]})\n'
    const aliased = '---\nimport Line from \'@kaynooo/kayjs-ui/timeline.kay\'\n---\nLine(label="Day" entries={[{ key: \'a\', time: \'1\', text: \'Old\' }]})\n'
    const root = await project({ 'src/routes/a.kay': both, 'src/routes/b.kay': other, 'src/routes/c.kay': unrelated, 'src/routes/d.kay': local })

    try {
      const found = await uiItems(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      await Bun.write(join(root, 'src/routes/e.kay'), aliased)
      expect(await uiItems(root, {})).toHaveLength(2)
      expect(await uiItems(root, { lints: { 'deprecated-ui-items': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
