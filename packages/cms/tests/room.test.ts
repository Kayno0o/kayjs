import { describe, expect, test } from 'bun:test'
import { presence } from 'kay'
import { editorsOf, entryRoom } from '../src/room'

const nobody = { name: '' }
const ada = { name: 'Ada' }
const watcher = { name: '', watching: true as const }

describe('entryRoom', () => {
  test('is the room an entry screen and an on-page editor share, and keeps room and member within what presence() takes', () => {
    const screen = entryRoom('posts', { slug: 'hello', locale: 'fr' }, ada)

    expect(screen).toEqual({ room: 'cms:posts:hello@fr', member: ada })
    expect(entryRoom('posts', { slug: 'hello', locale: 'fr' }, nobody).room).toBe(screen.room)

    const long = entryRoom('posts', { slug: 'a'.repeat(300) }, { name: 'N'.repeat(60) })

    expect(() => presence(long.room, long.member)).not.toThrow()
  })
})

describe('editorsOf', () => {
  test('names the others who have a name, and leaves out the ones only watching the list', () => {
    expect(editorsOf([ada, watcher], 2, nobody)).toEqual({ names: ['Ada'], unnamed: 0 })
  })

  test('counts the others of an editor with no name, every tab when nobody only watches', () => {
    expect(editorsOf([nobody], 3, nobody)).toEqual({ names: [], unnamed: 3 })
    expect(editorsOf([], 0, nobody)).toEqual({ names: [], unnamed: 0 })
  })

  test('does not count a tab that only watches the list as an editor', () => {
    expect(editorsOf([watcher], 1, nobody)).toEqual({ names: [], unnamed: 0 })
    expect(editorsOf([nobody, watcher], 2, nobody)).toEqual({ names: [], unnamed: 1 })
  })

  test('tells an editor with a name that an editor with none has the entry open too', () => {
    expect(editorsOf([nobody], 1, ada)).toEqual({ names: [], unnamed: 1 })
    expect(editorsOf([], 1, ada)).toEqual({ names: [], unnamed: 0 })
  })

  test('tells the list an entry is being edited, by name or not, never by another list', () => {
    expect(editorsOf([ada], 1, watcher)).toEqual({ names: ['Ada'], unnamed: 0 })
    expect(editorsOf([nobody], 1, watcher)).toEqual({ names: [], unnamed: 1 })
    expect(editorsOf([], 2, watcher)).toEqual({ names: [], unnamed: 0 })
  })
})
