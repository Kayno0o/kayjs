import { describe, expect, test } from 'bun:test'
import { presence } from 'kay'
import { editorsOf, entryRoom, watchRoom } from '../src/room'

const nobody = { name: '' }
const ada = { name: 'Ada' }
const watcher = { name: '', watching: true as const }

describe('entryRoom', () => {
  test('is the room an entry screen and an on-page editor share, and keeps room and member within what presence() takes, also through the room a list watches', () => {
    const screen = entryRoom('posts', { slug: 'hello', locale: 'fr' }, ada)

    expect(screen).toEqual({ room: 'cms:posts:hello@fr', member: ada })
    expect(entryRoom('posts', { slug: 'hello', locale: 'fr' }, nobody).room).toBe(screen.room)
    expect(entryRoom('posts', { slug: 'hello', locale: 'fr' }, watcher).room).toBe(screen.room)

    const long = entryRoom('posts', { slug: 'a'.repeat(300) }, { name: 'N'.repeat(60) })

    expect(() => presence(long.room, long.member)).not.toThrow()
    expect(() => presence(watchRoom(long.room), long.member)).not.toThrow()
  })

  test('names the same room whoever is listed, also for a slug of characters JSON escapes', () => {
    for (const slug of ['"'.repeat(300), '\u0001'.repeat(300), 'a'.repeat(300)]) {
      const rooms = [nobody, ada, watcher, { name: '\u0001'.repeat(60) }].map(member => entryRoom('posts', { slug }, member).room)

      expect(new Set(rooms).size).toBe(1)
    }
  })
})

describe('editorsOf', () => {
  test('names the others who have a name', () => {
    expect(editorsOf([ada], 1, nobody)).toEqual({ names: ['Ada'], unnamed: 0 })
  })

  test('counts the others of an editor with no name, their own other tabs included', () => {
    expect(editorsOf([nobody], 3, nobody)).toEqual({ names: [], unnamed: 3 })
    expect(editorsOf([], 0, nobody)).toEqual({ names: [], unnamed: 0 })
  })

  test('tells an editor with a name that an editor with none has the entry open too', () => {
    expect(editorsOf([nobody], 1, ada)).toEqual({ names: [], unnamed: 1 })
    expect(editorsOf([], 1, ada)).toEqual({ names: [], unnamed: 0 })
  })

  test('tells a list an entry is being edited, by name or not', () => {
    expect(editorsOf([ada], 1, watcher)).toEqual({ names: ['Ada'], unnamed: 0 })
    expect(editorsOf([nobody], 1, watcher)).toEqual({ names: [], unnamed: 1 })
    expect(editorsOf([], 2, watcher)).toEqual({ names: [], unnamed: 0 })
  })
})
