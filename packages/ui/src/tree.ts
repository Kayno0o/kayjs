import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

export type TreeId = string | number

// A node of a TreeView, a branch when it has children, even an empty list of them.
export interface TreeNode<Id extends TreeId = string> {
  id: Id
  label: string
  icon?: IconSlot | IconProps | undefined
  children?: readonly TreeNode<Id>[] | undefined
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
export function treeRows<Id extends TreeId>(nodes: readonly TreeNode<Id>[], open: ReadonlySet<TreeId>, level = 1, parent?: Id): TreeRow<Id>[] {
  const rows: TreeRow<Id>[] = []

  for (const [index, node] of nodes.entries()) {
    rows.push({ node, level, position: index + 1, size: nodes.length, parent })

    if (node.children && open.has(node.id))
      rows.push(...treeRows(node.children, open, level + 1, node.id))
  }

  return rows
}

// The ids of the branches holding the node, from the root down, or undefined when no node has that id.
export function treePath<Id extends TreeId>(nodes: readonly TreeNode<Id>[], id: TreeId): Id[] | undefined {
  for (const node of nodes) {
    if (node.id === id)
      return []

    const below = node.children && treePath(node.children, id)

    if (below)
      return [node.id, ...below]
  }

  return undefined
}

// What a key does on the focused row, as the ARIA tree pattern has it: the row to focus, or a branch to open or close.
// A printable character goes to the next row whose label starts with it, coming round after the last.
export type TreeMove<Id extends TreeId> = { focus: Id } | { open: Id } | { close: Id } | undefined

export function treeKey<Id extends TreeId>(rows: readonly TreeRow<Id>[], focused: TreeId, key: string, open: ReadonlySet<TreeId>): TreeMove<Id> {
  const index = rows.findIndex(row => row.node.id === focused)
  const row = rows[index]

  if (!row)
    return undefined

  const branch = row.node.children !== undefined
  const at = (other: number) => rows[other] && { focus: rows[other].node.id }

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

      if (!open.has(row.node.id))
        return { open: row.node.id }

      return rows[index + 1]?.parent === row.node.id ? at(index + 1) : undefined
    case 'ArrowLeft':
      if (branch && open.has(row.node.id))
        return { close: row.node.id }

      return row.parent === undefined ? undefined : { focus: row.parent }
    default: {
      if (key.length !== 1 || !key.trim())
        return undefined

      const typed = key.toLocaleLowerCase()
      const next = [...rows.slice(index + 1), ...rows.slice(0, index)].find(one => one.node.label.toLocaleLowerCase().startsWith(typed))

      return next && { focus: next.node.id }
    }
  }
}
