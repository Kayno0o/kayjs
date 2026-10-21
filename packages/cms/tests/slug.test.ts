import { describe, expect, test } from 'bun:test'
import { checkSlug, slugify } from '../src/slug'

describe('slugify', () => {
  test('writes an accented French title as the url a reader expects', () => {
    expect(slugify('Été à la ferme : Œufs, crème & Noël !', { final: true })).toBe('ete-a-la-ferme-oeufs-creme-noel')
    expect(slugify('Ça déjà « Straße » ŁÓDŹ', { final: true })).toBe('ca-deja-strasse-lodz')
  })

  test('keeps the letters and digits of any script', () => {
    expect(slugify('Привет, Мир 2', { final: true })).toBe('привет-мир-2')
    expect(slugify('你好 世界', { final: true })).toBe('你好-世界')
    expect(slugify('مرحبا بالعالم', { final: true })).toBe('مرحبا-بالعالم')
    expect(slugify('Café Привет', { final: true })).toBe('cafe-привет')
    // Marks that belong to another script's letters stay.
    for (const word of ['हिन्दी', 'สวัสดี', 'がっこう', 'йод', '한국어'])
      expect(slugify(word, { final: true })).toBe(word)

    // Greek tonos and Arabic harakat are marks too, so they stay with their letters, in any normalization the text arrived in.
    for (const word of ['καλημέρα', 'καλημέρα'.normalize('NFD'), 'مَرْحَبًا'])
      expect(slugify(word, { final: true })).toBe(word.normalize('NFC'))

    // A Latin letter followed by several marks loses them all.
    expect(slugify('e\u0301\u0302 a\u0308', { final: true })).toBe('e-a')
  })

  test('keeps folders, one slash between them, and no dash against a slash', () => {
    expect(slugify('Notes / 2024 //  Mon Article', { final: true })).toBe('notes/2024/mon-article')
    expect(slugify('/notes-/-a', { final: true })).toBe('notes/a')
  })

  test('keeps a trailing dash or slash while typing, and trims them at the end', () => {
    expect(slugify('mon ')).toBe('mon-')
    expect(slugify('notes/')).toBe('notes/')
    expect(slugify('mon ', { final: true })).toBe('mon')
    expect(slugify('--notes/', { final: true })).toBe('notes')
  })

  test('leaves a slug as it is, and an empty text empty', () => {
    expect(slugify('notes/mon-article_2')).toBe('notes/mon-article_2')
    expect(slugify('')).toBe('')
    expect(slugify('  !? ', { final: true })).toBe('')
  })
})

describe('checkSlug', () => {
  const existing = ['hello', 'notes/a', 'notes/2024/b', 'guides/start']

  test('flags a taken slug', () => {
    expect(checkSlug('hello', existing).taken).toBe(true)
    expect(checkSlug('notes/a', existing).taken).toBe(true)
    expect(checkSlug('hello2', existing).taken).toBe(false)
  })

  test('names the folder the slug lands in and the folders it creates', () => {
    expect(checkSlug('post', existing)).toEqual({ taken: false, inside: '', created: undefined, near: undefined })
    expect(checkSlug('notes/2024/c', existing)).toEqual({ taken: false, inside: 'notes/2024', created: undefined, near: undefined })
    expect(checkSlug('notes/2025/c', existing)).toEqual({ taken: false, inside: 'notes', created: '2025', near: undefined })
    expect(checkSlug('blog/2025/c', existing)).toMatchObject({ inside: '', created: 'blog/2025' })
  })

  test('flags a folder that looks like a typo of one that exists', () => {
    expect(checkSlug('noets/c', existing)).toMatchObject({ created: 'noets', near: 'notes' })
    expect(checkSlug('notes/2042/c', existing).near).toBeUndefined()
    expect(checkSlug('notes/dratfs/c', [...existing, 'notes/drafts/d'])).toMatchObject({ inside: 'notes', created: 'dratfs', near: 'notes/drafts' })
    expect(checkSlug('guide/c', existing)).toMatchObject({ near: 'guides' })
    expect(checkSlug('xy/c', existing).near).toBeUndefined()
  })
})
