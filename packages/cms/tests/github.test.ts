import { describe, expect, test } from 'bun:test'
import { fileVersion, ForgeError, SaveConflictError } from '../src/files'
import { github } from '../src/github'

type Tree = Map<string, string>

interface Body {
  base_tree: string
  tree: { path: string, sha?: null, content?: string }[]
  parents: string[]
  sha: string
  force: boolean
}

async function failureOf<T>(run: Promise<unknown>): Promise<T> {
  try {
    await run
  }
  catch (error) {
    return error as T
  }

  throw new Error('the call went through')
}

// A GitHub answering the REST endpoints the saver uses from an in-memory repository, with no network: commits hold whole trees, and a ref moves only to a child of its head.
function hub(initial: Record<string, string>, { refuse, between }: { refuse?: { method: string, pattern: RegExp, response: Response }, between?: (step: string, repo: ReturnType<typeof hub>['repo']) => void } = {}) {
  const trees = new Map<string, Tree>([['t0', new Map(Object.entries(initial))]])
  const commits = new Map<string, { tree: string, parents: string[], body: Record<string, unknown> }>([['c0', { tree: 't0', parents: [], body: {} }]])
  const refs = new Map<string, string>([['main', 'c0'], ['dev', 'c0']])
  const sent: { method: string, path: string, headers: Record<string, string>, body: Body }[] = []
  let count = 0
  const repo = {
    refs,
    commits,
    sent,
    // A push from someone else, adding or replacing a file on a branch.
    push(branch: string, path: string, content: string) {
      const id = `p${++count}`
      const tree = new Map(trees.get(commits.get(refs.get(branch)!)!.tree))

      tree.set(path, content)
      trees.set(`t-${id}`, tree)
      commits.set(id, { tree: `t-${id}`, parents: [refs.get(branch)!], body: {} })
      refs.set(branch, id)
    },
    files(branch: string) {
      return Object.fromEntries(trees.get(commits.get(refs.get(branch)!)!.tree)!)
    },
  }
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = decodeURIComponent(url.pathname).replace('/repos/me/site', '')
    const body = (init?.body === undefined ? undefined : JSON.parse(String(init.body))) as Body

    sent.push({ method, path: path + url.search, headers: init?.headers as Record<string, string>, body })

    if (refuse?.method === method && refuse.pattern.test(path))
      return refuse.response.clone()

    if (method === 'GET' && path === '')
      return Response.json({ default_branch: 'main' })

    let match = (/^\/git\/ref\/heads\/(.+)$/).exec(path)

    if (method === 'GET' && match)
      return refs.has(match[1]!) ? Response.json({ object: { sha: refs.get(match[1]!) } }) : Response.json({ message: 'Not Found' }, { status: 404 })

    match = (/^\/git\/commits\/(.+)$/).exec(path)

    if (method === 'GET' && match)
      return Response.json({ sha: match[1], tree: { sha: commits.get(match[1]!)!.tree } })

    match = (/^\/contents\/(.+)$/).exec(path)

    if (method === 'GET' && match) {
      const content = trees.get(commits.get(url.searchParams.get('ref')!)!.tree)!.get(match[1]!)

      return content === undefined ? Response.json({ message: 'Not Found' }, { status: 404 }) : Response.json({ type: 'file', sha: fileVersion(content) })
    }

    if (method === 'POST' && path === '/git/trees') {
      const tree = new Map(trees.get(body.base_tree))

      for (const entry of body.tree) {
        if (entry.sha === null) {
          if (!tree.delete(entry.path))
            return Response.json({ message: 'path not in tree' }, { status: 422 })
        }
        else {
          tree.set(entry.path, entry.content!)
        }
      }

      const id = `t${trees.size}`

      trees.set(id, tree)
      between?.('tree', repo)

      return Response.json({ sha: id }, { status: 201 })
    }

    if (method === 'POST' && path === '/git/commits') {
      const id = `c${commits.size}`

      commits.set(id, { tree: body.tree as unknown as string, parents: body.parents, body: body as unknown as Record<string, unknown> })

      return Response.json({ sha: id, html_url: `https://github.com/me/site/commit/${id}` }, { status: 201 })
    }

    match = (/^\/git\/refs\/heads\/(.+)$/).exec(path)

    if (method === 'PATCH' && match) {
      if (commits.get(body.sha)!.parents[0] !== refs.get(match[1]!))
        return Response.json({ message: 'Update is not a fast forward' }, { status: 422 })

      refs.set(match[1]!, body.sha)

      return Response.json({ object: { sha: body.sha } })
    }

    return Response.json({ message: 'unexpected' }, { status: 500 })
  }

  return { repo, saver: github({ repo: 'me/site', branch: 'main', token: 't0k', fetch: request as typeof fetch }), request }
}

const change = { absolute: '/unused', message: 'content(posts): update hello', author: { name: 'Kay', email: 'kay@example.com' } }

describe('github', () => {
  test('commits a file as a tree, a commit and a ref update, with the token', async () => {
    const { repo, saver } = hub({ 'content/posts/hello world.md': 'old' })

    expect(await saver.save({ ...change, repoPath: 'content/posts/hello world.md', text: 'héllo', base: fileVersion('old') })).toEqual({ sha: 'c1', url: 'https://github.com/me/site/commit/c1' })
    expect(repo.files('main')).toEqual({ 'content/posts/hello world.md': 'héllo' })
    expect(repo.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /git/ref/heads/main',
      'GET /contents/content/posts/hello world.md?ref=c0',
      'GET /git/commits/c0',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/main',
    ])
    expect(repo.sent[0]?.headers.authorization).toBe('Bearer t0k')
    expect(repo.commits.get('c1')?.body).toMatchObject({ message: 'content(posts): update hello', parents: ['c0'], author: { name: 'Kay', email: 'kay@example.com' } })
    expect(repo.sent.find(({ path }) => path === '/git/refs/heads/main')?.body.force).toBe(false)
  })

  test('creates a file the branch lacks, deletes one it holds, and writes nothing to delete one already gone', async () => {
    const { repo, saver } = hub({ 'a.md': 'a' })

    await saver.save({ ...change, repoPath: 'b.md', text: 'b', base: null })
    await saver.save({ ...change, repoPath: 'a.md', text: undefined })
    expect(repo.files('main')).toEqual({ 'b.md': 'b' })

    const before = repo.sent.length

    expect(await saver.save({ ...change, repoPath: 'a.md', text: undefined })).toBeUndefined()
    expect(repo.sent.slice(before).map(({ method }) => method)).toEqual(['GET', 'GET'])
  })

  test('uses the default branch when none is given, and the one named otherwise', async () => {
    const { repo, request } = hub({})
    const named = github({ repo: 'me/site', branch: 'dev', token: 't', fetch: request as typeof fetch })
    const unnamed = github({ repo: 'me/site', token: 't', fetch: request as typeof fetch })

    await named.save({ ...change, repoPath: 'a.md', text: 'a' })
    await unnamed.save({ ...change, repoPath: 'b.md', text: 'b' })
    expect(repo.files('dev')).toEqual({ 'a.md': 'a' })
    expect(repo.files('main')).toEqual({ 'b.md': 'b' })
  })

  test('refuses a change made from another version, and a new file already there, writing nothing', async () => {
    const { repo, saver } = hub({ 'a.md': 'a' })
    const stale = await failureOf<SaveConflictError>(saver.save({ ...change, repoPath: 'a.md', text: 'mine', base: 'a11ce' }))
    const taken = await failureOf<SaveConflictError>(saver.save({ ...change, repoPath: 'a.md', text: 'mine', base: null }))

    expect(stale).toBeInstanceOf(SaveConflictError)
    expect(stale.current).toBe(fileVersion('a'))
    expect(taken.creating).toBe(true)
    expect(repo.files('main')).toEqual({ 'a.md': 'a' })
    expect(repo.commits.size).toBe(1)
  })

  test('moves a file and rewrites its referrers in one commit', async () => {
    const { repo, saver } = hub({ 'old.md': 'o', 'ref.md': 'see old' })
    const commit = await saver.move!({
      from: { repoPath: 'old.md', absolute: '/x' },
      to: { repoPath: 'new.md', absolute: '/y' },
      text: 'o2',
      message: 'rename',
      base: fileVersion('o'),
      also: [{ repoPath: 'ref.md', absolute: '/z', text: 'see new', message: 'rename', base: fileVersion('see old') }],
    })

    expect(commit?.sha).toBe('c1')
    expect(repo.files('main')).toEqual({ 'ref.md': 'see new', 'new.md': 'o2' })
    expect(repo.commits.size).toBe(2)
    expect(saver.together).toBe(true)
  })

  test('refuses a move whose source is gone, target taken, or referrer saved since, writing nothing', async () => {
    const { repo, saver } = hub({ 'old.md': 'o', 'taken.md': 't', 'ref.md': 'r' })
    const move = async (from: string, to: string, also: { repoPath: string, base: string }[] = []) => failureOf<SaveConflictError>(saver.move!({
      from: { repoPath: from, absolute: '/x' },
      to: { repoPath: to, absolute: '/y' },
      text: 'x',
      message: 'rename',
      also: also.map(({ repoPath, base }) => ({ repoPath, absolute: '/z', text: 'n', message: 'rename', base })),
    }))

    expect(await move('missing.md', 'new.md')).toMatchObject({ current: null })
    expect(await move('old.md', 'taken.md')).toMatchObject({ creating: true })
    expect(await move('old.md', 'new.md', [{ repoPath: 'ref.md', base: 'a11ce' }])).toMatchObject({ at: 'ref.md', current: fileVersion('r') })
    expect(repo.commits.size).toBe(1)
  })

  test('saves several files all or nothing: a branch moving under it is read again, and a file changed by it is a conflict with nothing written', async () => {
    let pushed = false
    const { repo, saver } = hub({ 'old.md': 'o', 'ref.md': 'r', 'other.md': 'x' }, { between: (_, state) => {
      if (!pushed) {
        pushed = true
        state.push('main', 'other.md', 'y')
      }
    } })
    const move = {
      from: { repoPath: 'old.md', absolute: '/x' },
      to: { repoPath: 'new.md', absolute: '/y' },
      text: 'o2',
      message: 'rename',
      also: [{ repoPath: 'ref.md', absolute: '/z', text: 'r2', message: 'rename', base: fileVersion('r') }],
    }

    // Another file changed meanwhile: the head is read again and the commit made on it, losing nothing.
    await saver.move!(move)
    expect(repo.files('main')).toEqual({ 'other.md': 'y', 'ref.md': 'r2', 'new.md': 'o2' })

    // A referrer changed meanwhile: the retry finds it and the rename writes nothing.
    const second = hub({ 'old.md': 'o', 'ref.md': 'r' }, { between: (_, state) => {
      if (state.commits.size === 1)
        state.push('main', 'ref.md', 'changed')
    } })

    const outcome = await failureOf<SaveConflictError>(second.saver.move!(move))

    expect(outcome).toBeInstanceOf(SaveConflictError)
    expect(outcome).toMatchObject({ at: 'ref.md', current: fileVersion('changed') })
    expect(second.repo.files('main')).toEqual({ 'old.md': 'o', 'ref.md': 'changed' })
  })

  test('throws what GitHub said when it refuses', async () => {
    const { saver } = hub({}, { refuse: { method: 'GET', pattern: /git\/ref\//, response: Response.json({ message: 'Bad credentials' }, { status: 401 }) } })
    const failure = saver.save({ ...change, repoPath: 'a.md', text: 'a' })

    await expect(failure).rejects.toBeInstanceOf(ForgeError)
    await expect(failure).rejects.toThrow('GitHub answered 401: Bad credentials')
  })

  test('says a save may have gone through when the ref update is not answered, but not an earlier failure', async () => {
    const base = hub({})
    const unreachable = (failAt: RegExp) => async (input: string | URL | Request, init?: RequestInit) => {
      if (failAt.test(String(input)) && (init?.method ?? 'GET') !== 'GET')
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })

      return base.request(input, init)
    }
    const after = github({ repo: 'me/site', branch: 'main', token: 't', fetch: unreachable(/refs/) as typeof fetch })
    const before = github({ repo: 'me/site', branch: 'main', token: 't', fetch: unreachable(/trees/) as typeof fetch })

    await expect(after.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('Could not reach GitHub (ECONNRESET): the save may still have gone through')
    await expect(before.save({ ...change, repoPath: 'b.md', text: 'b' })).rejects.toThrow(/^Could not reach GitHub \(ECONNRESET\)$/)
  })

  test('fails a save GitHub does not answer within the timeout', async () => {
    const hanging = async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
    const saver = github({ repo: 'me/site', branch: 'main', token: 't', timeout: '50ms', fetch: hanging as typeof fetch })

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('GitHub did not answer within 0.05 s')
    expect(() => github({ repo: 'r', token: 't', timeout: 50 as never })).toThrow('kay: github timeout is 50')
  })

  test('reads a folder where a file should be as a refusal, and sends encoded paths to an Enterprise address', async () => {
    const seen: string[] = []
    const saver = github({ repo: 'me/site', branch: 'a/b', token: 't', baseUrl: 'https://ghe.example.com/api/v3/', fetch: (async (input: string) => {
      seen.push(input)

      return Response.json(input.includes('/contents/') ? [] : { object: { sha: 'c0' } })
    }) as unknown as typeof fetch })

    await expect(saver.save({ ...change, repoPath: 'dir', text: 'a' })).rejects.toThrow('is a folder')
    expect(seen).toEqual(['https://ghe.example.com/api/v3/repos/me/site/git/ref/heads/a/b', 'https://ghe.example.com/api/v3/repos/me/site/contents/dir?ref=c0'])
  })

  test('refuses a plain http address outside localhost, since the token travels in every request', () => {
    const make = (url: string) => () => github({ baseUrl: url, repo: 'me/site', token: 't' })

    expect(make('http://ghe.example.com')).toThrow('kay: github baseUrl is \'http://ghe.example.com\'')
    expect(make('http://localhost:3000')).not.toThrow()
    expect(make('https://ghe.example.com/api/v3')).not.toThrow()
  })
})

describe('github refusals of the ref update', () => {
  test('retries a 409 not a fast forward, and reports a branch still moving as a conflict', async () => {
    const { repo, saver } = hub({}, { refuse: { method: 'PATCH', pattern: /refs/, response: Response.json({ message: 'Update is not a fast forward' }, { status: 409 }) } })
    const failure = await failureOf<SaveConflictError>(saver.save({ ...change, repoPath: 'a.md', text: 'a' }))

    expect(failure).toBeInstanceOf(SaveConflictError)
    expect(repo.sent.filter(({ method }) => method === 'PATCH')).toHaveLength(3)
  })

  test('does not retry a refusal that is not about the branch moving, such as a protected branch', async () => {
    const { repo, saver } = hub({}, { refuse: { method: 'PATCH', pattern: /refs/, response: Response.json({ message: 'Protected branch update failed' }, { status: 422 }) } })
    const failure = await failureOf<ForgeError>(saver.save({ ...change, repoPath: 'a.md', text: 'a' }))

    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure.message).toBe('GitHub answered 422: Protected branch update failed')
    expect(repo.sent.filter(({ method }) => method === 'PATCH')).toHaveLength(1)
  })

  test('does not say a save may have gone through when it fails reading again after a refused update', async () => {
    let refs = 0
    const base = hub({})
    const flaky = github({ repo: 'me/site', branch: 'main', token: 't', fetch: (async (input: string, init?: RequestInit) => {
      if (String(input).includes('/git/refs/'))
        return Response.json({ message: 'Update is not a fast forward' }, { status: 422 })

      if (String(input).includes('/git/ref/') && ++refs === 2)
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })

      return base.request(input, init)
    }) as unknown as typeof fetch })

    await expect(flaky.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow(/^Could not reach GitHub \(ECONNRESET\)$/)
  })
})
