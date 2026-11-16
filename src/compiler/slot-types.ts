import type { KayFile } from './ast'
import type { PropsDeclaration } from './script-shared'
import { slotNames, templateFacts, visitNodes } from './ast'

// The blocks a template reads with `slot name` or `slot name(a, b)`, each with whether the component calls it with values.
function slotBlocks(file: KayFile): Map<string, boolean> {
  const blocks = new Map<string, boolean>()

  visitNodes(file.template, (node) => {
    if (node.kind !== 'element' || !node.outlet)
      return

    const name = file.source.slice(node.outlet.name.start, node.outlet.name.end)

    blocks.set(name, blocks.get(name) === true || node.outlet.args !== undefined)
  })

  return blocks
}

export interface SlotTypes {
  // The members as an intersection to add to the props type, none when there are none.
  type: string
  // The names of the slots a layout declares, which a page fills.
  outlets: string[]
  // The type imports those members read.
  imports: string
}

// What a component's props are typed from its template: the children and the blocks it renders with `slot`, which its props type does not declare, so an app declares neither to take them. A block read with values is a call, its arguments left to the props type declaring it. A layout's named slots are the blocks a page fills.
export function slotTypes(file: KayFile, kind: { component: boolean, layout: boolean, server: boolean }, props: PropsDeclaration | undefined, snippet: boolean): SlotTypes {
  const facts = templateFacts(file)
  const derivable = kind.component && !kind.server && (!props || props.keys !== undefined)
  const declared = new Set(props?.keys)
  const blocks = derivable ? [...slotBlocks(file)].filter(([name]) => name !== 'children' && !declared.has(name)) : []
  const outlets = kind.layout ? slotNames(file.template, file.source) : []
  const members = [
    ...facts.childrenSlot ? ['children?: KayJSX.Element'] : [],
    ...outlets.map(name => `${name}?: KayJSX.Element`),
    ...blocks.map(([name, called]) => `${name}?: ${called ? 'KaySlotCall' : 'KayJSX.Element'}`),
  ]
  const jsx = facts.childrenSlot || snippet || members.length > 0 ? 'import type { JSX as KayJSX } from \'kay\'\n' : ''
  const calls = blocks.some(([, called]) => called) ? 'import type { SlotCall as KaySlotCall } from \'kay\'\n' : ''

  return { type: members.length > 0 ? ` & { ${members.join('; ')} }` : '', outlets, imports: jsx + calls }
}
