import type { TestPage } from '../src/test'
import { expect } from 'bun:test'

interface Hydrating { $kayHydrate: (root?: ParentNode) => Promise<void> }

// Waits for the page to have run its scripts, which hold what a tab does about a deploy from the start.
export async function ready(page: TestPage): Promise<void> {
  await page.waitUntil(() => document.readyState === 'complete' && '$kayHydrate' in globalThis)
}

// Makes the page fetch the one deferred server island of the navigation fixture's home page, which the page replaced once it answered, `count` more times under its index 0, whose answers it checks for the build they name, and returns once each answered.
export async function askServerIslands(page: TestPage, count: number): Promise<void> {
  const pending = await page.evaluate(async (total) => {
    const slots: HTMLElement[] = []

    for (let index = 0; index < total; index++) {
      const slot = document.createElement('slot')

      slot.dataset.kayServer = '0'
      slot.setAttribute('inert', '')
      document.body.append(slot)
      slots.push(slot)
    }

    await (globalThis as unknown as Hydrating).$kayHydrate()

    for (let waited = 0; waited < 100 && slots.some(slot => slot.hasAttribute('inert')); waited++)
      await new Promise(resolve => setTimeout(resolve, 50))

    const left = slots.filter(slot => slot.hasAttribute('inert')).length
    const answered = slots.filter(slot => slot.querySelector('.aside') !== null).length

    for (const slot of slots)
      slot.remove()

    return left + (total - answered)
  }, count)

  expect(pending, 'server islands that never answered with the island').toBe(0)
}

// Makes the page hydrate an island whose chunk is gone, as one a deploy dropped, which asks whether the page is stale.
export async function loadDroppedChunk(page: TestPage): Promise<void> {
  await page.evaluate(async () => {
    const slot = document.createElement('slot')

    slot.dataset.component = 'gone/island.kay'
    slot.dataset.chunk = 'gone-chunk.js'
    document.body.append(slot)

    try {
      await (globalThis as unknown as Hydrating).$kayHydrate()
    }
    catch {
      // The chunk is gone for good: the failure is what the island reports once the page is not stale.
    }

    slot.remove()
  })
}
