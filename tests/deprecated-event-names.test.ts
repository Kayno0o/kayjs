import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { eventNames } from '../src/check/event-names'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('event-names-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-event-names', () => {
  it('moves the listeners and dispatches of the old names to the document, in a script and a fence', async () => {
    const script = [
      'addEventListener(\'kay-renew\', () => undefined)',
      'window.addEventListener(\'kay:install\', () => undefined)',
      'window.dispatchEvent(new CustomEvent(\'kai-chat-open\'))',
      'window.dispatchEvent(new CustomEvent(\'kai-chat-send\', { detail: text }))',
      'globalThis.dispatchEvent(new CustomEvent("kai-chat-draft", { detail: \'hi\' }))',
      '',
    ].join('\n')

    const page = '---\nwindow.addEventListener(\'kay-renew\', () => undefined)\n---\np hi\n'
    const root = await project({ 'src/a.ts': script, 'src/routes/page.kay': page })

    try {
      const found = await eventNames(root, {})

      expect(found).toHaveLength(6)
      expect(found.every(one => one.code === 'deprecated-event-names' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/a.ts')).text()).toBe([
        'document.addEventListener(\'kay:renew\', () => undefined)',
        'document.addEventListener(\'kay:install\', () => undefined)',
        'document.dispatchEvent(new CustomEvent(\'kai:chat-open\'))',
        'document.dispatchEvent(new CustomEvent(\'kai:chat-send\', { detail: { text: text } }))',
        'document.dispatchEvent(new CustomEvent("kai:chat-draft", { detail: { text: \'hi\' } }))',
        '',
      ].join('\n'))
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('window.addEventListener(\'kay-renew\'', 'document.addEventListener(\'kay:renew\''))
      expect(await eventNames(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a listener that may read the detail and a dispatch written otherwise, and leaves the document and other elements alone', async () => {
    const script = [
      'addEventListener(\'kay-dev-built\', event => event)',
      'window.dispatchEvent(new CustomEvent(\'kai-chat-send\', { detail: text, cancelable: true }))',
      'document.addEventListener(\'kay:install\', () => undefined)',
      'panel.dispatchEvent(new CustomEvent(\'kai-chat-send\', { detail: text }))',
      'addEventListener(\'kay:navigate\', () => undefined)',
      '',
    ].join('\n')

    const root = await project({ 'src/a.ts': script })

    try {
      const found = await eventNames(root, {})

      expect(found).toHaveLength(2)
      expect(found.every(one => one.fixes === undefined)).toBe(true)
      expect(await eventNames(root, { lints: { 'deprecated-event-names': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
