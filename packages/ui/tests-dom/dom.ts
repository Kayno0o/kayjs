import { jest } from 'bun:test'
import { settle } from 'kay/test'
import { join } from 'node:path'
import process from 'node:process'

// Preloaded after `kay/test/dom`, which registers happy-dom with its popover shim. Components mount from the fixture app, which installs the library and replaces its settings as an app does.
process.env.KAY_ROOT = join(import.meta.dir, '..', 'tests', 'fixture')

// A component of the library, by its path under the fixture's node_modules.
export function library(name: string): string {
  return `node_modules/@kaynooo/kayjs-ui/src/${name}.kay`
}

export function click(element: Element | null): void {
  if (!(element instanceof HTMLElement))
    throw new Error('nothing to click')

  element.click()
}

const STEP_MS = 10

// A fake clock for a test of what a timer does. `mount` and `settle` wait on a real timer, so a component is mounted first and the clock started after; `clock.settle` stands for `settle` from then on, and `clock.stop` ends it.
export const clock = {
  faked: false,
  start() {
    jest.useFakeTimers()
    this.faked = true
  },
  stop() {
    jest.useRealTimers()
    this.faked = false
  },
  // A few microtasks, in which the effects a change queued run and set their timers.
  async flush() {
    for (let tick = 0; tick < 5; tick++)
      await Promise.resolve()
  },
  // Runs the timers due within `ms` of fake time, in steps of 10 ms with the effects between them, as a clock running on would.
  async elapse(ms: number) {
    await this.flush()

    for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
      jest.advanceTimersByTime(Math.min(STEP_MS, ms - elapsed))
      await this.flush()
    }
  },
  async settle() {
    if (this.faked)
      await this.flush()
    else
      await settle()
  },
}
