import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineIslandElement } from '../src/dom/island'

describe('a failed island hydration (#3607)', () => {
  it('names the component in dev and only the chunk in production', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-island-error-'))
    const chunk = join(dir, 'island-abc123.mjs')
    writeFileSync(chunk, `export default function CartButton() { throw new Error('boom') }`)
    const nodeEnv = process.env.NODE_ENV
    GlobalRegistrator.register()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      defineIslandElement()
      const hydrateOnce = async (): Promise<string> => {
        log.mockClear()
        const island = document.createElement('kay-island')
        island.setAttribute('c', chunk)
        island.setAttribute('h', 'client')
        document.body.appendChild(island)
        await new Promise(resolve => setTimeout(resolve, 30))
        island.remove()
        return String(log.mock.calls[0]?.[0])
      }
      process.env.NODE_ENV = 'development'
      expect(await hydrateOnce()).toBe(`[kay-island] failed to hydrate <CartButton> (${chunk}):`)
      process.env.NODE_ENV = 'production'
      expect(await hydrateOnce()).toBe(`[kay-island] failed to hydrate ${chunk}:`)
    }
    finally {
      if (nodeEnv === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = nodeEnv
      log.mockRestore()
      await GlobalRegistrator.unregister()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
