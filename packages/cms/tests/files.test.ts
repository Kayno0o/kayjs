import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { fileVersion, ForgeError, forgejo, SaveConflict, workingTree } from '../src/files'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

// A Forgejo answering the contents API from a table of files, recording each request.
function forge(files: Record<string, string>, refuse?: Response) {
  const sent: Sent[] = []
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    sent.push({ url, method, headers: init?.headers as Record<string, string>, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })

    if (method === 'POST')
      return refuse ?? Response.json({ commit: { sha: 'c0ffee', html_url: 'https://git.example.com/me/site/commit/c0ffee' } }, { status: 201 })

    const path = decodeURIComponent(new URL(url).pathname.replace(/^.*\/contents\//, ''))
    const sha = files[path]

    return sha === undefined ? Response.json({ message: 'not found' }, { status: 404 }) : Response.json({ sha })
  }

  return { sent, saver: forgejo({ url: 'https://git.example.com/', repo: 'me/site', branch: 'main', token: 't0k', fetch: request as typeof fetch }) }
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
    const saver = forgejo({ url: 'https://git.example.com', repo: 'me/site', token: 't0k', timeout: 50, fetch: hanging as typeof fetch })
    const failure = saver.save({ ...change, repoPath: 'a.md', text: 'a' })

    await expect(failure).rejects.toBeInstanceOf(ForgeError)
    await expect(failure).rejects.toThrow('Forgejo did not answer within 0.05 s')
  })

  test('throws a proxy\'s plain-text refusal as it came', async () => {
    const { saver } = forge({}, new Response('Bad gateway', { status: 502 }))

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('Forgejo answered 502: Bad gateway')
  })
})

const dir = await mkdtemp(join(tmpdir(), 'kayjs-cms-'))

describe('workingTree', () => {
  afterAll(() => rm(dir, { recursive: true, force: true }))

  test('writes a file in folders it creates, then deletes it', async () => {
    const absolute = join(dir, 'content', 'posts', 'hello.md')
    const saver = workingTree()

    expect(await saver.save({ ...change, repoPath: 'content/posts/hello.md', absolute, text: 'hello' })).toBeUndefined()
    expect(await Bun.file(absolute).text()).toBe('hello')

    await saver.save({ ...change, repoPath: 'content/posts/hello.md', absolute, text: undefined })

    expect(await Bun.file(absolute).exists()).toBe(false)
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
