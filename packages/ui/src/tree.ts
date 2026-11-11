import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'
import type { MenuEntry } from './menu'
import type { NewTab } from './outside'
import { currentTab } from './tab-nav'

// A path of the site: one slash, not two, which would name another host.
const LOCAL_PATH = /^\/(?!\/)/

export type TreeId = string | number

interface TreeNodeBase<Id extends TreeId> {
  label: string
  icon?: IconSlot | IconProps | undefined
  // The nodes below it; a function returning them, or a promise of them, is called the first time the branch opens, so a tree whose branches come from a request is fetched a branch at a time.
  children?: TreeChildren<Id> | undefined
  // A site path or URL: the row is then a real link to it, and the node is the selected one while the page is on that address.
  href?: string | undefined
  // Opens the link in a new tab (`true`), the same one (`false`), or a new one when the address leaves the site (`'auto'`, the default).
  newTab?: NewTab | undefined
  // The row's context menu, opened by a right click, Shift+F10 or the Menu key on the focused row.
  menu?: readonly MenuEntry[] | undefined
}

// A node of a TreeView, a branch when it has children, even an empty list of them. `key` tells it apart and is what `selected`, `expanded` and the callbacks carry; `id` is the name it had before 1.100, deprecated: `key` wins when both are given.
export type TreeNode<Id extends TreeId = string> = TreeNodeBase<Id> & ({ key: Id, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-item-keys` finds it. */ id?: Id | undefined } | { key?: undefined, /** @deprecated Use `key`, which wins when both are given. Removed in 1.103, `deprecated-ui-item-keys` finds it. */ id: Id })

// The identity of a node, its `key` or the older `id`.
export function nodeKey<Id extends TreeId>(node: TreeNode<Id>): Id {
  return node.key ?? node.id
}

export type TreeChildren<Id extends TreeId = string> = readonly TreeNode<Id>[] | (() => readonly TreeNode<Id>[] | Promise<readonly TreeNode<Id>[]>)

// The nodes below a node when they are known: its list, else none yet.
function listed<Id extends TreeId>(node: TreeNode<Id>): readonly TreeNode<Id>[] | undefined {
  return typeof node.children === 'function' ? undefined : node.children
}

// A node as the tree shows it: its depth from 1, its place among its siblings, and the branch holding it.
export interface TreeRow<Id extends TreeId = string> {
  node: TreeNode<Id>
  level: number
  position: number
  size: number
  parent: Id | undefined
}

// The rows a tree shows, in reading order: every root, and the children of each open branch.
// `kids` tells the nodes below a branch whose children are a function: those it loaded so far.
export function treeRows<Id extends TreeId>(nodes: readonly TreeNode<Id>[], open: ReadonlySet<TreeId>, level = 1, parent?: Id, kids: (node: TreeNode<Id>) => readonly TreeNode<Id>[] | undefined = listed): TreeRow<Id>[] {
  const rows: TreeRow<Id>[] = []

  for (const [index, node] of nodes.entries()) {
    rows.push({ node, level, position: index + 1, size: nodes.length, parent })

    const below = open.has(nodeKey(node)) ? kids(node) : undefined

    if (below)
      rows.push(...treeRows(below, open, level + 1, nodeKey(node), kids))
  }

  return rows
}

// The ids of the branches holding the node, from the root down, or undefined when no node has that id.
export function treePath<Id extends TreeId>(nodes: readonly TreeNode<Id>[], id: TreeId): Id[] | undefined {
  for (const node of nodes) {
    if (nodeKey(node) === id)
      return []

    const below = listed(node) && treePath(listed(node)!, id)

    if (below)
      return [nodeKey(node), ...below]
  }

  return undefined
}

// Whether any node, at any depth, has a context menu to open.
export function treeHasMenu<Id extends TreeId>(nodes: readonly TreeNode<Id>[]): boolean {
  return nodes.some(node => (node.menu?.length ?? 0) > 0 || (listed(node) !== undefined && treeHasMenu(listed(node)!)) || typeof node.children === 'function')
}

// The first node whose `href` is the page `current` names, by the rule of TabNav's current tab: the same path with every param the link sets matching, the link setting the most params winning.
export function treeHere<Id extends TreeId>(nodes: readonly TreeNode<Id>[], current: URL): Id | undefined {
  const linked: TreeNode<Id>[] = []

  const collect = (list: readonly TreeNode<Id>[]) => {
    for (const node of list) {
      if (node.href !== undefined && LOCAL_PATH.test(node.href))
        linked.push(node)

      if (listed(node))
        collect(listed(node)!)
    }
  }

  collect(nodes)

  const href = currentTab(linked.map(node => ({ href: node.href! })), current)

  const found = linked.find(node => node.href === href)

  return found && nodeKey(found)
}

// What a key does on the focused row, as the ARIA tree pattern has it: the row to focus, or a branch to open or close.
// A printable character goes to the next row whose label starts with it, coming round after the last.
export type TreeMove<Id extends TreeId> = { focus: Id } | { open: Id } | { close: Id } | undefined

export function treeKey<Id extends TreeId>(rows: readonly TreeRow<Id>[], focused: TreeId, key: string, open: ReadonlySet<TreeId>): TreeMove<Id> {
  const index = rows.findIndex(row => nodeKey(row.node) === focused)
  const row = rows[index]

  if (!row)
    return undefined

  const branch = row.node.children !== undefined
  const at = (other: number) => rows[other] && { focus: nodeKey(rows[other].node) }

  switch (key) {
    case 'ArrowDown':
      return at(index + 1)
    case 'ArrowUp':
      return at(index - 1)
    case 'Home':
      return at(0)
    case 'End':
      return at(rows.length - 1)
    case 'ArrowRight':
      if (!branch)
        return undefined

      if (!open.has(nodeKey(row.node)))
        return { open: nodeKey(row.node) }

      return rows[index + 1]?.parent === nodeKey(row.node) ? at(index + 1) : undefined
    case 'ArrowLeft':
      if (branch && open.has(nodeKey(row.node)))
        return { close: nodeKey(row.node) }

      return row.parent === undefined ? undefined : { focus: row.parent }
    default: {
      if (key.length !== 1 || !key.trim())
        return undefined

      const typed = key.toLocaleLowerCase()
      const next = [...rows.slice(index + 1), ...rows.slice(0, index)].find(one => one.node.label.toLocaleLowerCase().startsWith(typed))

      return next && { focus: nodeKey(next.node) }
    }
  }
}
