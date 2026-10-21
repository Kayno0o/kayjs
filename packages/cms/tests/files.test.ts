import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { scratchDir } from 'kay/test'
import { fileVersion, ForgeError, forgejo, SaveConflict, workingTree } from '../src/files'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

// A Forgejo answering the contents API from a table of files, recording each request.
function forge(files: Record<string, string>, refuse?: Response, onPost?: () => void) {
  const sent: Sent[] = []
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    sent.push({ url, method, headers: init?.headers as Record<string, string>, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })

    if (method === 'POST') {
      onPost?.()

      return refuse ?? Response.json({ commit: { sha: 'c0ffee', html_url: 'https://git.example.com/me/site/commit/c0ffee' } }, { status: 201 })
    }

    const path = decodeURIComponent(new URL(url).pathname.replace(/^.*\/contents\//, ''))
    const sha = files[path]

    return sha === undefined ? Response.json({ message: 'not found' }, { status: 404 }) : Response.json({ sha })
  }

  return { sent, saver: forgejo({ url: 'https://git.example.com/', repo: 'me/site', branch: 'main', token: 't0k', fetch: request as typeof fetch }) }
}

async function failureOf<T extends Error>(save: Promise<unknown>): Promise<T> {
  try {
    await save
  }
  catch (error) {
    return error as T
  }

  throw new Error('the save went through')
}

const change = { absolute: '/unused', message: 'content(posts): update hello', author: { name: 'Kay', email: 'kay@example.com' } }

describe('forgejo', () => {
  test('updates a file the branch holds, naming its sha', async () => {
    const { sent, saver } = forge({ 'content/posts/hello world.md': 'b10b' })

    expect(await saver.save({ ...change, repoPath: 'content/posts/hello world.md', text: 'héllo' })).toEqual({ sha: 'c0ffee', url: 'https://git.example.com/me/site/commit/c0ffee' })
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET https://git.example.com/api/v1/repos/me/site/contents/content/posts/hello%20world.md?ref=main',
      'POST https://git.example.com/api/v1/repos/me/site/contents',
    ])
    expect(sent[1]?.headers.authorization).toBe('token t0k')
    expect(sent[1]?.body).toEqual({
      branch: 'main',
      message: 'content(posts): update hello',
      author: { name: 'Kay', email: 'kay@example.com' },
      files: [{ operation: 'update', path: 'content/posts/hello world.md', sha: 'b10b', content: Buffer.from('héllo').toString('base64') }],
    })
  })

  test('creates a file the branch lacks, and deletes one it holds', async () => {
    const { sent, saver } = forge({ 'content/posts/old.md': 'b10b' })

    await saver.save({ ...change, repoPath: 'content/posts/new.md', text: 'new' })
    await saver.save({ ...change, repoPath: 'content/posts/old.md', text: undefined })

    expect(sent.filter(({ method }) => method === 'POST').map(({ body }) => (body as { files: unknown[] }).files[0])).toEqual([
      { operation: 'create', path: 'content/posts/new.md', content: Buffer.from('new').toString('base64') },
      { operation: 'delete', path: 'content/posts/old.md', sha: 'b10b' },
    ])
  })

  test('commits nothing to delete a file already gone', async () => {
    const { sent, saver } = forge({})

    expect(await saver.save({ ...change, repoPath: 'content/posts/gone.md', text: undefined })).toBeUndefined()
    expect(sent.map(({ method }) => method)).toEqual(['GET'])
  })

  test('throws what Forgejo said when it refuses', async () => {
    const { saver } = forge({}, Response.json({ message: 'branch is protected' }, { status: 403 }))
    const failure = saver.save({ ...change, repoPath: 'a.md', text: 'a' })

    await expect(failure).rejects.toBeInstanceOf(ForgeError)
    await expect(failure).rejects.toThrow('Forgejo answered 403: branch is protected')
  })

  test('refuses a change made from a version the branch no longer holds, and a new file the branch already holds', async () => {
    const { sent, saver } = forge({ 'content/posts/hello.md': 'b10b' })

    await expect(saver.save({ ...change, repoPath: 'content/posts/hello.md', text: 'mine', base: 'a11ce' })).rejects.toBeInstanceOf(SaveConflict)
    await expect(saver.save({ ...change, repoPath: 'content/posts/hello.md', text: 'mine', base: null })).rejects.toBeInstanceOf(SaveConflict)
    expect(sent.map(({ method }) => method)).toEqual(['GET', 'GET'])

    await saver.save({ ...change, repoPath: 'content/posts/hello.md', text: 'mine', base: 'b10b' })
    expect(sent.at(-1)?.method).toBe('POST')
  })

  test('fails a save the forge does not answer within the timeout', async () => {
    const hanging = async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
    const saver = forgejo({ url: 'https://git.example.com', repo: 'me/site', token: 't0k', timeout: '50ms', fetch: hanging as typeof fetch })
    const failure = saver.save({ ...change, repoPath: 'a.md', text: 'a' })

    await expect(failure).rejects.toBeInstanceOf(ForgeError)
    await expect(failure).rejects.toThrow('Forgejo did not answer within 0.05 s')
  })

  test('reads the timeout as a duration, and refuses one that is none or a bare number', async () => {
    const hanging = async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
    const saver = forgejo({ url: 'https://git.example.com', repo: 'me/site', token: 't0k', timeout: '50ms', fetch: hanging as typeof fetch })

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('Forgejo did not answer within 0.05 s')
    expect(() => forgejo({ url: 'u', repo: 'r', token: 't', timeout: 50 as never })).toThrow('kayjs-cms: forgejo timeout is 50')
    expect(() => forgejo({ url: 'u', repo: 'r', token: 't', timeout: 'soon' as never })).toThrow('kayjs-cms: forgejo timeout is \'soon\'')
  })

  test('refuses a plain http address outside localhost, since the token travels in every request', () => {
    const make = (url: string) => () => forgejo({ url, repo: 'me/site', token: 't0k' })

    expect(make('http://git.example.com')).toThrow('kayjs-cms: forgejo url is \'http://git.example.com\'')
    expect(make('git.example.com')).toThrow('kayjs-cms: forgejo url')
    expect(make('ftp://git.example.com')).toThrow('kayjs-cms: forgejo url')
    expect(make('http://localhost:3000')).not.toThrow()
    expect(make('http://127.0.0.1:3000')).not.toThrow()
    expect(make('http://[::1]:3000')).not.toThrow()
    expect(make('https://git.example.com')).not.toThrow()
  })

  test('throws a proxy\'s plain-text refusal as it came, cut to its first 200 characters', async () => {
    const { saver } = forge({}, new Response('Bad gateway', { status: 502 }))

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('Forgejo answered 502: Bad gateway')

    const page = `<html>${'x'.repeat(5000)}</html>`
    const long = forge({}, new Response(page, { status: 502 }))
    const failure = await failureOf(long.saver.save({ ...change, repoPath: 'a.md', text: 'a' }))

    expect(failure.message).toBe(`Forgejo answered 502: ${page.slice(0, 200)}…`)
  })

  test('times the save as a whole, and says a commit timed out once sent may still have gone through', async () => {
    const slow = async (input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(init?.method === 'POST' ? Response.json({ commit: { sha: 'c0ffee' } }) : Response.json({ message: 'not found' }, { status: 404 })), 40)

      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal?.reason)
      })
      void input
    })
    // Each request is under the timeout, both together over it.
    const saver = forgejo({ url: 'https://git.example.com', repo: 'me/site', token: 't0k', timeout: '60ms', fetch: slow as typeof fetch })

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('Forgejo did not answer within 0.06 s: the save may still have gone through, so check the repository before saving again')
  })

  test('names why the forge could not be reached', async () => {
    const refused = async () => {
      throw Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })
    }
    const saver = forgejo({ url: 'https://git.example.com', repo: 'me/site', token: 't0k', fetch: refused as unknown as typeof fetch })
    const failure = await failureOf<ForgeError>(saver.save({ ...change, repoPath: 'a.md', text: 'a' }))

    expect(failure).toBeInstanceOf(ForgeError)
    expect([failure.status, failure.message]).toEqual([502, 'Could not reach Forgejo (ConnectionRefused)'])
  })

  test('takes Forgejo refusing the commit\'s sha as a conflict, with the version the branch holds now', async () => {
    const files: Record<string, string> = { 'content/posts/hello.md': 'b10b' }
    const { saver } = forge(files, Response.json({ message: 'sha does not match [given: b10b, expected: f00d]' }, { status: 422 }))
    const raced = saver.save({ ...change, repoPath: 'content/posts/hello.md', text: 'mine', base: 'b10b' })

    // Another save lands between the read and the commit.
    files['content/posts/hello.md'] = 'f00d'
    await expect(raced).rejects.toMatchObject({ current: 'f00d', creating: false })

    const taken = forge({}, Response.json({ message: 'repository file already exists' }, { status: 409 }))

    await expect(taken.saver.save({ ...change, repoPath: 'new.md', text: 'new', base: null })).rejects.toThrow('An entry with this slug already exists: pick another slug')
  })
})

describe('forgejo timeout', () => {
  test('gives the read of the version a conflict reports its own time, not what the commit left of the save\'s', async () => {
    const wait = async (signal: AbortSignal | null | undefined, ms: number) => {
      await Bun.sleep(ms)
      signal?.throwIfAborted()
    }
    let reads = 0
    const request = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const posting = init?.method === 'POST'

      // The first read is quick, the commit takes most of the timeout, and the read after the conflict would not fit in what is left.
      const firstRead = !posting && reads++ === 0
      const delay = firstRead ? 2 : 30

      await wait(init?.signal, posting ? 40 : delay)

      return posting ? Response.json({ message: 'conflict' }, { status: 409 }) : Response.json({ sha: 'f00d' })
    }
    const saver = forgejo({ url: 'https://git.example.com', repo: 'me/site', token: 't0k', timeout: '60ms', fetch: request as typeof fetch })

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'mine', base: 'f00d' })).rejects.toMatchObject({ current: 'f00d' })
  })
})

const dir = await scratchDir('files-')

describe('workingTree', () => {
  afterAll(async () => rm(dir, { recursive: true, force: true }))

  test('writes a file in folders it creates, then deletes it', async () => {
    const absolute = join(dir, 'content', 'posts', 'hello.md')
    const saver = workingTree()

    expect(await saver.save({ ...change, repoPath: 'content/posts/hello.md', absolute, text: 'hello' })).toBeUndefined()
    expect(await Bun.file(absolute).text()).toBe('hello')

    await saver.save({ ...change, repoPath: 'content/posts/hello.md', absolute, text: undefined })

    expect(await Bun.file(absolute).exists()).toBe(false)
  })

  test('checks and writes one save of a file at a time, so two made from one version never both go through', async () => {
    const absolute = join(dir, 'content', 'posts', 'twice.md')
    const saver = workingTree()

    await saver.save({ ...change, repoPath: 'content/posts/twice.md', absolute, text: 'first', base: null })

    const outcomes = await Promise.allSettled(['mine', 'theirs'].map(async text => saver.save({ ...change, repoPath: 'content/posts/twice.md', absolute, text, base: fileVersion('first') })))

    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(await Bun.file(absolute).text()).toBe('mine')
  })

  test('refuses a change made from a version the file no longer has', async () => {
    const absolute = join(dir, 'content', 'posts', 'race.md')
    const saver = workingTree()

    await saver.save({ ...change, repoPath: 'content/posts/race.md', absolute, text: 'first', base: null })
    await expect(saver.save({ ...change, repoPath: 'content/posts/race.md', absolute, text: 'again', base: null })).rejects.toBeInstanceOf(SaveConflict)
    await expect(saver.save({ ...change, repoPath: 'content/posts/race.md', absolute, text: 'stale', base: fileVersion('older') })).rejects.toBeInstanceOf(SaveConflict)
    await saver.save({ ...change, repoPath: 'content/posts/race.md', absolute, text: 'second', base: fileVersion('first') })

    expect(await Bun.file(absolute).text()).toBe('second')
  })
})

describe('fileVersion', () => {
  test('is the git blob sha Forgejo names a file by', () => {
    expect(fileVersion('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
})

describe('moving a file', () => {
  const move = { from: { repoPath: 'content/posts/old.md', absolute: '/unused/old' }, to: { repoPath: 'content/posts/new.md', absolute: '/unused/new' }, text: 'moved', message: 'content(posts): rename old to new' }

  test('forgejo deletes the old path and creates the new one in one commit', async () => {
    const { sent, saver } = forge({ 'content/posts/old.md': 'b10b' })

    expect(await saver.move!({ ...move, base: 'b10b' })).toEqual({ sha: 'c0ffee', url: 'https://git.example.com/me/site/commit/c0ffee' })

    const posts = sent.filter(request => request.method === 'POST')

    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({ branch: 'main', message: move.message, files: [{ operation: 'delete', path: 'content/posts/old.md', sha: 'b10b' }, { operation: 'create', path: 'content/posts/new.md', content: Buffer.from('moved').toString('base64') }] })
  })

  test('forgejo refuses a move over a file at the new path, from a version that changed, or from a file that is gone', async () => {
    const taken = await failureOf<SaveConflict>(forge({ 'content/posts/old.md': 'b10b', 'content/posts/new.md': 'beef' }).saver.move!(move))

    expect(taken).toBeInstanceOf(SaveConflict)
    expect(taken.creating).toBe(true)

    const stale = forge({ 'content/posts/old.md': 'b10b' })

    expect((await failureOf<SaveConflict>(stale.saver.move!({ ...move, base: 'other' }))).current).toBe('b10b')
    expect(stale.sent.some(request => request.method === 'POST')).toBe(false)
    expect((await failureOf<SaveConflict>(forge({}).saver.move!(move))).current).toBeNull()
  })

  test('forgejo reports a move another commit raced as a conflict', async () => {
    const { saver } = forge({ 'content/posts/old.md': 'b10b' }, Response.json({ message: 'sha does not match' }, { status: 422 }))

    expect(await failureOf(saver.move!(move))).toBeInstanceOf(SaveConflict)
  })

  test('the working tree moves the file, and refuses a taken path or a stale version', async () => {
    const dir = await scratchDir('move-working-tree')
    const saver = workingTree()
    const at = (name: string) => ({ repoPath: `posts/${name}`, absolute: join(dir, name) })

    await Bun.write(join(dir, 'old.md'), 'before')

    const stale = await failureOf<SaveConflict>(saver.move!({ ...move, from: at('old.md'), to: at('deep/new.md'), base: fileVersion('else') }))

    expect(stale.current).toBe(fileVersion('before'))
    expect(await Bun.file(join(dir, 'old.md')).exists()).toBe(true)

    await saver.move!({ ...move, from: at('old.md'), to: at('deep/new.md'), base: fileVersion('before') })
    expect(await Bun.file(join(dir, 'old.md')).exists()).toBe(false)
    expect(await Bun.file(join(dir, 'deep/new.md')).text()).toBe('moved')

    await Bun.write(join(dir, 'other.md'), 'x')
    expect((await failureOf<SaveConflict>(saver.move!({ ...move, from: at('other.md'), to: at('deep/new.md') }))).creating).toBe(true)
    expect((await failureOf<SaveConflict>(saver.move!({ ...move, from: at('gone.md'), to: at('free.md') }))).current).toBeNull()
  })

  test('forgejo commits the files that named the moved one in the same commit, and writes nothing when one changed', async () => {
    const also = { repoPath: 'content/books/engine.md', absolute: '/unused/engine', text: 'pointed', message: 'm', base: 'a1' }
    const { sent, saver } = forge({ 'content/posts/old.md': 'b10b', 'content/books/engine.md': 'a1' })

    await saver.move!({ ...move, also: [also] })
    expect(sent.filter(each => each.method === 'POST')[0]?.body).toMatchObject({ files: [{ operation: 'delete' }, { operation: 'create' }, { operation: 'update', path: 'content/books/engine.md', sha: 'a1', content: Buffer.from('pointed').toString('base64') }] })

    const stale = forge({ 'content/posts/old.md': 'b10b', 'content/books/engine.md': 'a2' })
    const conflict = await failureOf<SaveConflict>(stale.saver.move!({ ...move, also: [also] }))

    expect(conflict.at).toBe('content/books/engine.md')
    expect(stale.sent.filter(each => each.method === 'POST')).toEqual([])
  })

  test('forgejo names the referrer a racing save changed when the commit is refused, and the moved file when it is the one that changed', async () => {
    const also = { repoPath: 'content/books/engine.md', absolute: '/unused/engine', text: 'pointed', message: 'm', base: 'a1' }
    const files: Record<string, string> = { 'content/posts/old.md': 'b10b', 'content/books/engine.md': 'a1' }
    const referrer = forge(files, Response.json({ message: 'conflict' }, { status: 409 }), () => files['content/books/engine.md'] = 'a2')

    expect((await failureOf<SaveConflict>(referrer.saver.move!({ ...move, also: [also] }))).at).toBe('content/books/engine.md')

    const moved: Record<string, string> = { 'content/posts/old.md': 'b10b', 'content/books/engine.md': 'a1' }
    const own = forge(moved, Response.json({ message: 'conflict' }, { status: 409 }), () => moved['content/posts/old.md'] = 'b20b')

    expect((await failureOf<SaveConflict>(own.saver.move!({ ...move, also: [also] }))).at).toBeUndefined()
  })

  test('forgejo reads the versions of a move and its referrers together, under the one timeout', async () => {
    const slow = async (input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const free = String(input).includes('/new.md')
      const answer = () => init?.method === 'POST' ? Response.json({ commit: { sha: 'c0ffee' } }) : Response.json(free ? { message: 'not found' } : { sha: 'a1' }, { status: free ? 404 : 200 })
      const timer = setTimeout(() => resolve(answer()), 40)

      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal?.reason)
      })
    })
    const saver = forgejo({ url: 'https://git.example.com', repo: 'me/site', token: 't0k', timeout: '150ms', fetch: slow as typeof fetch })
    const also = ['one', 'two', 'three'].map(name => ({ repoPath: `content/books/${name}.md`, absolute: `/unused/${name}`, text: 'pointed', message: 'm', base: 'a1' }))

    await saver.move!({ ...move, from: { repoPath: 'content/posts/old.md', absolute: '/unused/old' }, to: { repoPath: 'content/posts/new.md', absolute: '/unused/new' }, base: 'a1', also })
  })

  test('the working tree writes the files that named the moved one with it, or none when one changed', async () => {
    const dir = await scratchDir('move-also')
    const saver = workingTree()
    const at = (name: string) => ({ repoPath: `posts/${name}`, absolute: join(dir, name) })

    await Bun.write(join(dir, 'old.md'), 'before')
    await Bun.write(join(dir, 'book.md'), 'book')

    const stale = await failureOf<SaveConflict>(saver.move!({ ...move, from: at('old.md'), to: at('new.md'), also: [{ ...at('book.md'), text: 'pointed', message: 'm', base: fileVersion('else') }] }))

    expect(stale.at).toBe('posts/book.md')
    expect(await Bun.file(join(dir, 'old.md')).exists()).toBe(true)
    expect(await Bun.file(join(dir, 'new.md')).exists()).toBe(false)

    await saver.move!({ ...move, from: at('old.md'), to: at('new.md'), also: [{ ...at('book.md'), text: 'pointed', message: 'm', base: fileVersion('book') }] })
    expect(await Bun.file(join(dir, 'book.md')).text()).toBe('pointed')
    expect(await Bun.file(join(dir, 'old.md')).exists()).toBe(false)
  })

  test('the working tree runs a save and a move of one file one after the other', async () => {
    const dir = await scratchDir('move-race')
    const saver = workingTree()
    const old = { repoPath: 'posts/old.md', absolute: join(dir, 'old.md') }
    const next = { repoPath: 'posts/new.md', absolute: join(dir, 'new.md') }

    await Bun.write(old.absolute, 'before')

    const outcomes = await Promise.allSettled([
      saver.save({ ...old, text: 'edited', message: 'edit', base: fileVersion('before') }),
      saver.move!({ ...move, from: old, to: next, base: fileVersion('before') }),
    ])

    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(await Bun.file(old.absolute).text()).toBe('edited')
    expect(await Bun.file(next.absolute).exists()).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})
