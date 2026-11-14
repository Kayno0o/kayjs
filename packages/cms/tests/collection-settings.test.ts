import { describe, expect, test } from 'bun:test'
import { anyFourEyes, configure, fourEyesOf, hooksOf } from '../src/settings'

const global = () => undefined
const own = () => undefined

describe('what a collection sets beside the cms\'s own', () => {
  test('its hooks follow the global ones, and only for it', () => {
    configure({ onSave: global, beforeSave: global, collections: { posts: { onSave: own, beforeSave: own, beforeUpload: own, onUpload: own } } })

    expect(hooksOf('onSave', 'posts')).toEqual([global, own])
    expect(hooksOf('beforeSave', 'posts')).toEqual([global, own])
    expect(hooksOf('onSave', 'pages')).toEqual([global, undefined])
    expect(hooksOf('beforeUpload', 'posts')).toEqual([undefined, own])
    expect(hooksOf('onUpload', 'posts')).toEqual([undefined, own])
    expect(hooksOf('onSave', undefined)).toEqual([global, undefined])
  })

  test('fourEyes of a collection replaces the cms\'s, whichever way', () => {
    configure({ collections: { posts: { fourEyes: true } } })
    expect(fourEyesOf('posts')).toBe(true)
    expect(fourEyesOf('pages')).toBe(false)
    expect(anyFourEyes()).toBe(true)

    configure({ fourEyes: true, collections: { drafts: { fourEyes: false } } })
    expect(fourEyesOf('drafts')).toBe(false)
    expect(fourEyesOf('pages')).toBe(true)

    configure({})
    expect(anyFourEyes()).toBe(false)
  })

  test('refuses a hook that is no function, a fourEyes that is no boolean and a key it does not know', () => {
    expect(() => configure({ collections: { posts: { onSave: 'x' as never } } })).toThrow('takes a function')
    expect(() => configure({ collections: { posts: { fourEyes: 'yes' as never } } })).toThrow('takes true or false')
    expect(() => configure({ collections: { posts: { onPublish: own } as never } })).toThrow('onPublish')
  })
})
