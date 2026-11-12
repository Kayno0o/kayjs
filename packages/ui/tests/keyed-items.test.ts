import type { TimelineEntry } from '../src/timeline'
import type { TreeNode } from '../src/tree'
import { describe, expect, test } from 'bun:test'
import { keyedApp } from '../src/app-switcher'
import { labelledChapter } from '../src/audio'
import { labelledEntry } from '../src/timeline'
import { keyedNode } from '../src/tree'

// The helpers behind the blocks and callbacks of TreeView, AppSwitcher, AudioPlayer and Timeline: an item under an old name gets the new one, any other comes back as it is.
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

describe('keyedApp', () => {
  test('fills key from id', () => {
    expect(keyedApp(old({ id: 'a', href: '/a', label: 'A' })).key).toBe('a')
  })

  test('returns an app holding key as it is', () => {
    const app = { key: 'a', href: '/a', label: 'A' }

    expect(keyedApp(app)).toBe(app)
  })
})

describe('labelledChapter', () => {
  test('fills label from title', () => {
    expect(labelledChapter(old({ title: 'Intro', start: 0 })).label).toBe('Intro')
  })

  test('returns a chapter holding label as it is', () => {
    const chapter = { label: 'Intro', start: 0 }

    expect(labelledChapter(chapter)).toBe(chapter)
  })
})

describe('labelledEntry', () => {
  test('fills label from text', () => {
    expect(labelledEntry(old<TimelineEntry>({ key: 'a', time: '08:00', text: 'Wake' })).label).toBe('Wake')
  })

  test('returns an entry holding label as it is', () => {
    const entry = { key: 'a', time: '08:00', label: 'Wake' }

    expect(labelledEntry(entry)).toBe(entry)
  })
})
