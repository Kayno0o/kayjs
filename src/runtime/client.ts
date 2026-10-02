import type { JSX } from '@solidjs/web'
import { hydrate } from '@solidjs/web'

export type IslandRegistry = Record<string, () => Promise<{ default: (props: object) => JSX.Element }>>

// Hydrates every `<kay-island>` the server rendered, loading each component's chunk on demand.
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<void> {
  const islands = [...root.querySelectorAll<HTMLElement>('kay-island')]

  await Promise.all(islands.map(async (element) => {
    const id = element.dataset.component ?? ''
    const load = registry[id]

    if (!load) {
      console.error(`[kay] no client chunk for island ${id}`)

      return
    }

    const { default: component } = await load()
    const props = JSON.parse(element.dataset.props ?? '{}') as object

    hydrate(() => component(props), element, { renderId: element.dataset.renderId })
  }))
}
