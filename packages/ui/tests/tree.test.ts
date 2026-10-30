import type { TreeNode } from '../src/tree'
import { describe, expect, test } from 'bun:test'
import { treeHasMenu, treeHere, treeKey, treePath, treeRows } from '../src/tree'

const nodes: TreeNode[] = [
  { id: 'work', label: 'Work', children: [{ id: 'specs', label: 'Specs', children: [{ id: 'api', label: 'API' }] }, { id: 'notes', label: 'Notes' }] },
  { id: 'empty', label: 'Empty', children: [] },
  { id: 'inbox', label: 'Inbox' },
]
const ids = (open: string[]) => treeRows(nodes, new Set(open)).map(row => `${row.node.id} ${row.level} ${row.position}/${row.size} ${row.parent ?? '-'}`)

describe('treeRows', () => {
  test('shows the roots, and the children of each open branch under it', () => {
    expect(ids([])).toEqual(['work 1 1/3 -', 'empty 1 2/3 -', 'inbox 1 3/3 -'])
    expect(ids(['work', 'specs'])).toEqual(['work 1 1/3 -', 'specs 2 1/2 work', 'api 3 1/1 specs', 'notes 2 2/2 work', 'empty 1 2/3 -', 'inbox 1 3/3 -'])
  })

  test('hides the children of an open branch under a closed one', () => {
    expect(ids(['specs'])).toEqual(['work 1 1/3 -', 'empty 1 2/3 -', 'inbox 1 3/3 -'])
  })
})

describe('treePath', () => {
  test('gives the branches holding a node, from the root down', () => {
    expect([treePath(nodes, 'api'), treePath(nodes, 'work'), treePath(nodes, 'nothing')]).toEqual([['work', 'specs'], [], undefined])
  })
})

describe('treeKey', () => {
  const open = new Set(['work'])
  const rows = treeRows(nodes, open)
  const key = (focused: string, pressed: string) => treeKey(rows, focused, pressed, open)

  test('moves up and down the rows shown, and to the first and the last', () => {
    expect([key('work', 'ArrowDown'), key('notes', 'ArrowDown'), key('inbox', 'ArrowDown'), key('work', 'ArrowUp'), key('specs', 'Home'), key('specs', 'End')]).toEqual([{ focus: 'specs' }, { focus: 'empty' }, undefined, undefined, { focus: 'work' }, { focus: 'inbox' }])
  })

  test('opens a closed branch, then goes to its first child, and does nothing on a leaf or an empty branch', () => {
    expect([key('specs', 'ArrowRight'), key('work', 'ArrowRight'), key('notes', 'ArrowRight'), key('empty', 'ArrowRight')]).toEqual([{ open: 'specs' }, { focus: 'specs' }, undefined, { open: 'empty' }])
    expect(treeKey(treeRows(nodes, new Set(['empty'])), 'empty', 'ArrowRight', new Set(['empty']))).toBeUndefined()
  })

  test('closes an open branch, else goes to the branch holding the row', () => {
    expect([key('work', 'ArrowLeft'), key('notes', 'ArrowLeft'), key('inbox', 'ArrowLeft'), key('notes', 'a')]).toEqual([{ close: 'work' }, { focus: 'work' }, undefined, undefined])
  })
})

describe('typeahead', () => {
  const open = new Set(['work'])
  const rows = treeRows(nodes, open)
  const key = (focused: string, pressed: string) => treeKey(rows, focused, pressed, open)

  test('goes to the next row shown whose label starts with the letter, coming round after the last', () => {
    expect([key('work', 'n'), key('inbox', 'W'), key('specs', 's'), key('work', 'x'), key('work', ' ')]).toEqual([{ focus: 'notes' }, { focus: 'work' }, undefined, undefined, undefined])
  })
})

test('takes numbers as ids, 0 included', () => {
  const numbered: TreeNode<number>[] = [{ id: 0, label: 'Root', children: [{ id: 1, label: 'Leaf' }] }]
  const open = new Set([0])

  expect([treePath(numbered, 1), treeKey(treeRows(numbered, open), 1, 'ArrowLeft', open), treeKey(treeRows(numbered, open), 0, 'ArrowLeft', open)]).toEqual([[0], { focus: 0 }, { close: 0 }])
})

describe('treeHere', () => {
  const linked: TreeNode[] = [
    { id: 'all', label: 'All', href: '/projects' },
    { id: 'group', label: 'Group', children: [{ id: 'beta', label: 'Beta', href: '/projects/beta/' }, { id: 'list', label: 'List', href: '/projects/beta?view=list#top' }] },
    { id: 'home', label: 'Home', href: '/' },
  ]

  test('gives the node whose href is the address, ignoring a trailing slash and the hash', () => {
    expect([treeHere(linked, '/projects'), treeHere(linked, '/projects/beta'), treeHere(linked, '/')]).toEqual(['all', 'beta', 'home'])
  })

  test('prefers the node naming the query, else falls back to the one with the path alone', () => {
    expect([treeHere(linked, '/projects/beta?view=list'), treeHere(linked, '/projects/beta?view=grid'), treeHere(linked, '/projects/beta?page=2')]).toEqual(['list', 'beta', 'beta'])
  })

  test('gives nothing for an address no href names, and a path is not matched by a prefix of it', () => {
    expect([treeHere(linked, '/elsewhere'), treeHere(linked, '/projects/be')]).toEqual([undefined, undefined])
  })
})

describe('treeHasMenu', () => {
  test('finds a menu at any depth, an empty one counting for none', () => {
    const item = { label: 'Rename', onSelect: () => undefined }

    expect([treeHasMenu(nodes), treeHasMenu([{ id: 'a', label: 'A', menu: [] }]), treeHasMenu([{ id: 'a', label: 'A', children: [{ id: 'b', label: 'B', menu: [item] }] }])]).toEqual([false, false, true])
  })
})
