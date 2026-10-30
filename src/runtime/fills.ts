// The blocks a page, or a layout, writes at the root of its template (`@sidebar`) for the layout above it to render at its `slot sidebar`, collected while one route renders.
export interface FillChain {
  // The module of the route being entered, layouts outermost first and the page last: the one a `fill` call belongs to.
  at: number
  // Per module, its blocks by name.
  blocks: Map<string, () => unknown>[]
}

let active: FillChain | undefined

export function newFillChain(length: number): FillChain {
  return { at: 0, blocks: Array.from({ length }, () => new Map()) }
}

export function inFillChain<T>(chain: FillChain, render: () => T): T {
  const outer = active

  active = chain

  try {
    return render()
  }
  finally {
    active = outer
  }
}

// What the generated code calls where the template writes `@name`: it keeps the block for the layout, and renders nothing where it stands. Outside a route's render there is no layout to take it.
export function fill(name: string, block: () => unknown): string {
  active?.blocks[active.at]?.set(name, block)

  return ''
}

// The block the `slot name` of the layout at `layout` renders: the deepest one written below it, down to the first layout under it declaring the same slot, which takes the blocks written below itself.
export function filledBy(chain: FillChain, declared: readonly (readonly string[] | undefined)[], layout: number, name: string): { block: () => unknown, at: number } | undefined {
  const end = declared.findIndex((names, index) => index > layout && names?.includes(name) === true)

  for (let index = end === -1 ? chain.blocks.length - 1 : end; index > layout; index--) {
    const block = chain.blocks[index]?.get(name)

    if (block !== undefined)
      return { block, at: index }
  }

  return undefined
}
