import type { GuardContext } from 'kay'
import { describe, expect, test } from 'bun:test'
import { presence } from 'kay'
import { entryPresence } from '../src/presence'
import { configure } from '../src/settings'

const ctx = {} as GuardContext
const key = (entry: { room: string, member: { name: string } }) => JSON.stringify([entry.room, entry.member])

// What the entry screen does with it: presence() throws for a room and member past 256 characters.
const opens = (entry: { room: string, member: { name: string } }) => presence(entry.room, entry.member)

describe('the room editors of an entry share', () => {
  test('names the collection, the slug and the locale, and lists the editor by the author\'s name', async () => {
    configure({ author: () => ({ name: 'Ada', email: 'ada@example.com' }) })

    expect(await entryPresence(ctx, 'posts', { slug: 'hello', locale: 'fr' })).toEqual({ room: 'cms:posts:hello@fr', member: { name: 'Ada' } })
    expect((await entryPresence(ctx, 'posts', { slug: 'hello' })).room).toBe('cms:posts:hello')
  })

  test('shortens a long slug before the editor\'s name, and keeps both within the 256 characters presence() takes', async () => {
    const name = 'N'.repeat(60)

    configure({ author: () => ({ name, email: 'ada@example.com' }) })

    const entry = await entryPresence(ctx, 'posts', { slug: 'a'.repeat(300), locale: 'fr' })

    expect(entry.member.name).toBe(name)
    expect(key(entry).length).toBeLessThanOrEqual(256)
    expect(() => opens(entry)).not.toThrow()
  })

  test('measures the room again after cutting it, for a slug of quotes and characters JSON escapes', async () => {
    const name = 'Ada "the editor" Lovelace'

    configure({ author: () => ({ name, email: 'ada@example.com' }) })

    for (const slug of ['"'.repeat(300), '\\'.repeat(300), '\n'.repeat(300), '\uD800'.repeat(300)]) {
      const entry = await entryPresence(ctx, 'posts', { slug })

      expect(entry.member.name).toBe(name)
      expect(key(entry).length).toBeLessThanOrEqual(256)
      expect(() => opens(entry)).not.toThrow()
      expect(() => opens(entry)).not.toThrow()
    }
  })

  test('keeps rooms apart when their slugs only differ past the cut', async () => {
    configure({})

    const first = await entryPresence(ctx, 'posts', { slug: `${'a'.repeat(300)}1` })
    const second = await entryPresence(ctx, 'posts', { slug: `${'a'.repeat(300)}2` })

    expect(first.room).not.toBe(second.room)
  })

  test('trims the name only when even the shortest room leaves no space for it', async () => {
    configure({ author: () => ({ name: '\u0001'.repeat(60), email: 'ada@example.com' }) })

    const entry = await entryPresence(ctx, 'posts', { slug: 'a'.repeat(300) })

    expect(key(entry).length).toBeLessThanOrEqual(256)
    expect(() => opens(entry)).not.toThrow()
    expect(entry.member.name.length).toBeGreaterThan(0)
  })
})
