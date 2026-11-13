import type { TreeNode } from '../src/tree'
import { describe, expect, test } from 'bun:test'
import { keyedNode } from '../src/tree'

// The helper behind the blocks and callbacks of TreeView: a node under the old name gets the new one, any other comes back as it is.
const old = <T>(item: unknown) => item as T

describe('keyedNode', () => {
  test('fills key from id', () => {
    expect(keyedNode(old<TreeNode>({ id: 'a', label: 'A' })).key).toBe('a')
  })

  test('returns a node holding key as it is', () => {
    const node = { key: 'a', label: 'A' }

    expect(keyedNode(node)).toBe(node)
  })
})
