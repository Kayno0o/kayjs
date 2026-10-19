import { mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { safePath } from '../src/server'
import { scratchDir } from './scratch'

let base: string
let root: string

beforeAll(async () => {
  base = await realpath(await scratchDir('safe-path-'))
  root = join(base, 'media')
  await mkdir(join(root, 'sub'), { recursive: true })
  await mkdir(join(base, 'outside'), { recursive: true })
  await mkdir(join(base, 'media-other'), { recursive: true })
  await Promise.all([
    Bun.write(join(root, 'a.png'), 'a'),
    Bun.write(join(root, 'sub/b.png'), 'b'),
    Bun.write(join(root, '..%2fx'), 'literal'),
    Bun.write(join(root, '%2e%2e%2fsecret'), 'literal'),
    Bun.write(join(base, 'secret.txt'), 'secret'),
    Bun.write(join(base, 'outside/c.png'), 'c'),
    Bun.write(join(base, 'media-other/d.png'), 'd'),
  ])
  await symlink(join(root, 'a.png'), join(root, 'inside-link'))
  await symlink(join(base, 'secret.txt'), join(root, 'out-link'))
  await symlink(join(base, 'outside'), join(root, 'out-dir'))
  await symlink(join(base, 'nowhere'), join(root, 'dangling'))
  await symlink(root, join(base, 'media-link'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('safePath', () => {
  it('gives the real path of a file inside the root, a nested one and one named with a leading slash included', () => {
    expect(safePath(root, 'a.png')).toBe(join(root, 'a.png'))
    expect(safePath(root, 'sub/b.png')).toBe(join(root, 'sub/b.png'))
    expect(safePath(root, '/a.png')).toBe(join(root, 'a.png'))
    expect(safePath(root, 'sub/../a.png')).toBe(join(root, 'a.png'))
  })

  it('refuses a name climbing out with ../, however it is spelled', () => {
    expect(safePath(root, '../secret.txt')).toBeUndefined()
    expect(safePath(root, 'sub/../../secret.txt')).toBeUndefined()
    expect(safePath(root, '../media-other/d.png')).toBeUndefined()
    expect(safePath(root, '..')).toBeUndefined()
    expect(safePath(root, './../secret.txt')).toBeUndefined()
  })

  it('reads an absolute path as relative to the root, so it never reaches the filesystem\'s', () => {
    expect(safePath(root, join(base, 'secret.txt'))).toBeUndefined()
    expect(safePath(root, '/etc/passwd')).toBeUndefined()
    expect(safePath(root, root)).toBeUndefined()
  })

  it('follows a symlink inside the root to a file inside it, and refuses one leading out, dangling or a directory', () => {
    expect(safePath(root, 'inside-link')).toBe(join(root, 'a.png'))
    expect(safePath(root, 'out-link')).toBeUndefined()
    expect(safePath(root, 'out-dir/c.png')).toBeUndefined()
    expect(safePath(root, 'dangling')).toBeUndefined()
  })

  it('does not decode a name, so %2e%2e is a file of that name, and a Windows separator never escapes', () => {
    expect(safePath(root, '%2e%2e%2fsecret')).toBe(join(root, '%2e%2e%2fsecret'))
    expect(safePath(root, '..%2fx')).toBe(join(root, '..%2fx'))
    expect(safePath(root, '%2e%2e/secret.txt')).toBeUndefined()
    expect(safePath(root, '..\\a.png')).toBeUndefined()
    expect(safePath(root, 'sub\\..\\..\\secret.txt')).toBeUndefined()
    expect(safePath(root, 'C:\\secret.txt')).toBeUndefined()
    expect(safePath(root, '..\\secret.txt')).toBeUndefined()
  })

  it('gives undefined for a NUL byte, an empty name, the root, a directory and a missing file, without throwing', () => {
    expect(safePath(root, 'a.png\0.txt')).toBeUndefined()
    expect(safePath(root, '\0')).toBeUndefined()
    expect(safePath(root, '')).toBeUndefined()
    expect(safePath(root, '.')).toBeUndefined()
    expect(safePath(root, 'sub')).toBeUndefined()
    expect(safePath(root, 'missing.png')).toBeUndefined()
    expect(safePath(join(base, 'no-root'), 'a.png')).toBeUndefined()
  })

  it('works when the root is itself a symlink, still refusing a link out of its target', () => {
    const link = join(base, 'media-link')

    expect(safePath(link, 'a.png')).toBe(join(root, 'a.png'))
    expect(safePath(link, 'out-link')).toBeUndefined()
    expect(safePath(link, '../secret.txt')).toBeUndefined()
  })

  it('resolves a relative root against the working directory', () => {
    const cwd = process.cwd()

    process.chdir(base)

    try {
      expect(safePath('media', 'a.png')).toBe(join(root, 'a.png'))
      expect(safePath('media', '../secret.txt')).toBeUndefined()
    }
    finally {
      process.chdir(cwd)
    }
  })
})
