import type { TestPage } from '../src/test'

// Makes the page's wait for a page, a chunk or a transition last a moment, as a timer of exactly one of those lengths fires after `to` instead.
export async function shorten(page: TestPage, bounds: number[], to = 100): Promise<void> {
  await page.evaluate((lengths, to) => {
    const original = window.setTimeout.bind(window)

    window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => original(handler, delay !== undefined && lengths.includes(delay) ? to : delay, ...rest)) as typeof window.setTimeout
  }, bounds, to)
}
