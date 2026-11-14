import { describe, expect, test } from 'bun:test'
import { anyFourEyes, configure, fourEyesOf, hooksOf } from '../src/settings'

const global = () => undefined
const own = () => undefined

describe('what a collection sets beside the cms\'s own', () => {
  test('its hooks follow the global ones, and only for it', () => {
    configure({ afterSave: global, beforeSave: global, collections: { posts: { afterSave: own, beforeSave: own, beforeUpload: own, afterUpload: own } } })

    expect(hooksOf('afterSave', 'posts')).toEqual([global, own])
    expect(hooksOf('beforeSave', 'posts')).toEqual([global, own])
    expect(hooksOf('afterSave', 'pages')).toEqual([global, undefined])
    expect(hooksOf('beforeUpload', 'posts')).toEqual([undefined, own])
    expect(hooksOf('afterUpload', 'posts')).toEqual([undefined, own])
    expect(hooksOf('afterSave', undefined)).toEqual([global, undefined])
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
    expect(() => configure({ collections: { posts: { afterSave: 'x' as never } } })).toThrow('takes a function')
    expect(() => configure({ collections: { posts: { fourEyes: 'yes' as never } } })).toThrow('takes true or false')
    expect(() => configure({ collections: { posts: { onPublish: own } as never } })).toThrow('onPublish')
  })
})

describe('onSave and onUpload, the names before 1.105', () => {
  test('are read as afterSave and afterUpload, the new names winning', () => {
    configure({ onSave: global, onUpload: global, collections: { posts: { onSave: own, afterUpload: own, onUpload: global } } })

    expect(hooksOf('afterSave', 'posts')).toEqual([global, own])
    expect(hooksOf('afterUpload', 'posts')).toEqual([global, own])
    configure({ onSave: global, afterSave: own })
    expect(hooksOf('afterSave', undefined)).toEqual([own, undefined])
  })
})
