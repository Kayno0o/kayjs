import { symlinkSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { testWorker } from '../src/build/assets'
import { cacheDir } from '../src/project'
import { diskFiles, memoryFiles, pages } from '../src/server'
import { privateDir } from '../src/server/private-dir'
import { setupStorage, storedImage } from '../src/server/storage'
import { scratchDir } from './scratch'

const modeOf = async (path: string) => (await lstat(path)).mode & 0o777
const KEY = `private/${'a'.repeat(20)}.txt`
const OTHER = `${'b'.repeat(20)}.txt`

// Run with a umask that lets everything through, which is what a service started oddly has.
async function openUmask<Result>(run: () => Promise<Result>): Promise<Result> {
  const before = process.umask(0)

  try {
    return await run()
  }
  finally {
    process.umask(before)
  }
}

describe('privateDir', () => {
  it('makes the folder closed to others under a umask of 000, and its parents too', async () => {
    const root = await scratchDir('private-dir-')
    const path = join(root, 'a/b/images')

    expect(await openUmask(async () => privateDir(path))).toBe(path)
    expect(await modeOf(path)).toBe(0o700)
  })

  it('closes a folder an older kay or a loose umask left open, keeping what is in it', async () => {
    const path = join(await scratchDir('private-dir-'), 'images')

    await mkdir(path)
    await chmod(path, 0o755)
    await writeFile(join(path, 'kept.txt'), 'kept')
    expect(await privateDir(path)).toBe(path)
    expect(await modeOf(path)).toBe(0o700)
    expect(await readFile(join(path, 'kept.txt'), 'utf8')).toBe('kept')
  })

  it('never uses a link planted at the path, nor writes through it', async () => {
    const root = await scratchDir('private-dir-')
    const target = join(root, 'planted')
    const path = join(root, 'images')

    await mkdir(target)
    await chmod(target, 0o755)
    symlinkSync(target, path)

    const chosen = await privateDir(path)

    expect(chosen).not.toBe(path)
    expect(await modeOf(chosen)).toBe(0o700)
    expect(await modeOf(target)).toBe(0o755)
    expect(await readdir(target)).toEqual([])
  })

  it('picks another private folder when the path cannot be made', async () => {
    const root = await scratchDir('private-dir-')

    await writeFile(join(root, 'file'), 'x')

    const chosen = await privateDir(join(root, 'file/images'))

    expect(chosen).not.toStartWith(root)
    expect(await modeOf(chosen)).toBe(0o700)
  })
})

describe('the stored files cache', () => {
  async function cached(content = 'secret') {
    const cache = await privateDir(join(await scratchDir('private-cache-'), 'cache'))
    const store = memoryFiles()

    await store.write(OTHER, new Blob([content]))
    setupStorage(store, join(cache, 'stored'))

    return { cache: join(cache, 'stored'), store }
  }

  it('copies a file at 0600, whatever the umask', async () => {
    const { cache } = await cached()
    const found = await openUmask(async () => storedImage(`/_kay/files/${OTHER}`))

    expect(await modeOf((found as { path: string }).path)).toBe(0o600)
    expect(await modeOf(join(cache, OTHER))).toBe(0o600)
  })

  it('replaces a copy readable by everyone that an older kay left, and one another user planted as a link', async () => {
    const { cache } = await cached('real')
    const secret = join(await scratchDir('private-target-'), 'target.txt')
    const copy = join(cache, OTHER)

    await mkdir(cache, { recursive: true })
    await writeFile(secret, 'untouched')
    await writeFile(copy, 'old')
    await chmod(copy, 0o644)

    const found = await storedImage(`/_kay/files/${OTHER}`)

    expect(await readFile((found as { path: string }).path, 'utf8')).toBe('real')
    expect(await modeOf(copy)).toBe(0o600)

    await Bun.$`rm ${copy}`
    symlinkSync(secret, copy)
    await storedImage(`/_kay/files/${OTHER}`)
    expect(await readFile(secret, 'utf8')).toBe('untouched')
    expect((await lstat(copy)).isSymbolicLink()).toBe(false)
    expect(await readFile(copy, 'utf8')).toBe('real')
    expect(await modeOf(copy)).toBe(0o600)
  })
})

describe('diskFiles', () => {
  it('writes private files at 0600 in folders at 0700 under a umask of 000, public ones as before', async () => {
    const root = await scratchDir('private-disk-')
    const store = diskFiles(root)
    const nested = `private/photos/${'c'.repeat(20)}.txt`

    await openUmask(async () => {
      await store.write(KEY, new Blob(['secret']))
      await store.write(nested, new Blob(['secret']))
      await store.write(OTHER, new Blob(['public']))
    })
    expect(await modeOf(join(root, KEY))).toBe(0o600)
    expect(await modeOf(join(root, nested))).toBe(0o600)
    expect(await modeOf(join(root, 'private'))).toBe(0o700)
    expect(await modeOf(join(root, 'private/photos'))).toBe(0o700)
    expect(await modeOf(join(root, OTHER))).toBe(0o666)
    expect(await readFile(join(root, KEY), 'utf8')).toBe('secret')
  })

  it('closes the private folder an older kay made open, so files written before stay out of reach', async () => {
    const root = await scratchDir('private-disk-')
    const old = join(root, `private/${'d'.repeat(20)}.txt`)

    await mkdir(join(root, 'private'), { recursive: true })
    await chmod(join(root, 'private'), 0o755)
    await writeFile(old, 'old')
    await diskFiles(root).write(KEY, new Blob(['secret']))
    expect(await modeOf(join(root, 'private'))).toBe(0o700)
    expect((await stat(old)).size).toBe(3)
  })
})

describe('the server', () => {
  it('keeps the image cache closed to other users', async () => {
    await pages({ routes: 'tests/fixtures/storage/src/routes', prebuilt: false, security: false, storage: memoryFiles() })
    expect(await modeOf(cacheDir(process.cwd(), `images${testWorker()}`))).toBe(0o700)
  })

  it('has an executable cache per user and per executable, closed to others', async () => {
    const script = `
      import { registerBundle } from './src/server/bundle'
      import { projectSource } from './src/server/source'
      import { privateDir } from './src/server/private-dir'
      registerBundle({ root: '/x', routes: [], fallback: {}, modules: {}, config: {}, clientDir: '/x', publicDir: '/x' })
      const path = projectSource().imageCache('/x')
      console.log(JSON.stringify([path, await privateDir(path)]))
    `
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [out, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const [path, chosen] = JSON.parse(out) as [string, string]

    expect(errors).toBe('')
    expect(path).toMatch(/kay-images-\w+-[\da-z]+$/)
    expect(path).not.toMatch(/kay-images$/)
    expect(chosen).toBe(path)
    expect(await modeOf(path)).toBe(0o700)
  })
})
