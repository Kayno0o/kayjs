import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { slugOf, splitReference, writeReference } from '../docs/split'
import { check } from '../src/check'

const root = join(import.meta.dir, '..')
const llms = await Bun.file(join(root, 'llms.txt')).text()
const SECTION = /^## (.+)$/gm

describe('the documentation site', () => {
  it('gives every section of llms.txt a page of its own, under a slug no other takes', () => {
    const { topics } = splitReference(llms)
    const sections = [...llms.matchAll(SECTION)].map(match => match[1]!)

    expect(topics.map(topic => topic.title)).toEqual(sections)
    expect(new Set(topics.map(topic => topic.slug)).size).toBe(topics.length)
    expect(slugOf('What `kay check` verifies')).toBe('what-kay-check-verifies')
  })

  it('links a pointer to another section to its page, and leaves one to no section as written', () => {
    const { topics } = splitReference('Opening\n\n## Navigation\n\nSwaps pages.\n\n## Actions\n\nPosts forms (see Navigation), held by a store (see Elsewhere), swapped and posted (see Navigation and Actions).\n')

    expect(topics[1]!.body).toBe('Posts forms (see [Navigation](/reference/navigation)), held by a store (see Elsewhere), swapped and posted (see [Navigation](/reference/navigation) and [Actions](/reference/actions)).')
  })

  it('passes kay check, its pages written from llms.txt as it is now, and so does the tutorial\'s example app', async () => {
    expect(await writeReference()).toBe([...llms.matchAll(SECTION)].length + 1)
    expect(await check(join(root, 'docs'))).toEqual([])
    expect(await check(join(root, 'examples/reading-list'))).toEqual([])
  }, 60_000)
})
