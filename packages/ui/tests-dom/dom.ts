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
