import type { Component, SafeHtml } from 'kay'
import { join } from 'node:path'
import { highlightCode } from 'kay/content'
import { highlight } from './highlight'

interface Demo {
  component: Component
  html: SafeHtml
}

const EXAMPLE = /^\.\/ui-examples\/(.+)\.kay$/

// Every src/ui-examples/<component>/<name>.kay by the name `<Demo name="button/variants" />` gives it, with its highlighted source.
const demos = new Map(await Promise.all(Object.entries(import.meta.glob<Component>('./ui-examples/*/*.kay', { eager: true, import: 'default' })).map(async ([path, component]): Promise<[string, Demo]> => [EXAMPLE.exec(path)![1]!, { component, html: await highlightCode((await Bun.file(join(import.meta.dir, path)).text()).trimEnd(), 'kay', { highlight }) }])))

export function demo(name: string): Demo {
  const found = demos.get(name)

  if (!found)
    throw new Error(`No demo at docs/src/ui-examples/${name}.kay`)

  return found
}
