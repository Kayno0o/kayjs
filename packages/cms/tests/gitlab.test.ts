import { describe, expect, test } from 'bun:test'
import { fileVersion, ForgeError, SaveConflictError } from '../src/files'
import { gitlab } from '../src/gitlab'

interface Action {
  action: 'create' | 'update' | 'delete' | 'move'
  file_path: string
  previous_path?: string
  content?: string
  last_commit_id?: string
}

interface Body {
  branch: string
  commit_message: string
  actions: Action[]
  author_name?: string
  author_email?: string
}

interface File {
  content: string
  last: string
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

// A GitLab answering the REST endpoints the saver uses from an in-memory repository, with no network: a commit applies all its actions or none, and refuses a stale `last_commit_id` as GitLab does.
function lab(initial: Record<string, string>, { refuse, between }: { refuse?: { method: string, pattern: RegExp, response: Response }, between?: (repo: ReturnType<typeof lab>['repo']) => void } = {}) {
  const branches = new Map<string, Map<string, File>>([
    ['main', new Map(Object.entries(initial).map(([path, content]) => [path, { content, last: 'c0' }]))],
    ['dev', new Map()],
  ])
  const heads = new Map([['main', 'c0'], ['dev', 'c0']])
  const sent: { method: string, path: string, headers: Record<string, string>, body: Body }[] = []
  let count = 0
  const repo = {
    sent,
    commits: [] as Body[],
    // A push from someone else.
    push(branch: string, path: string, content: string) {
      const id = `p${++count}`

      branches.get(branch)!.set(path, { content, last: id })
      heads.set(branch, id)
    },
    files(branch: string) {
      return Object.fromEntries([...branches.get(branch)!].map(([path, file]) => [path, file.content]))
    },
  }
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = decodeURIComponent(url.pathname).replace('/api/v4/projects/me/site', '')
    const body = (init?.body === undefined ? undefined : JSON.parse(String(init.body))) as Body

    sent.push({ method, path: path + url.search, headers: init?.headers as Record<string, string>, body })

    if (refuse?.method === method && refuse.pattern.test(path))
      return refuse.response.clone()

    if (method === 'GET' && path === '')
      return Response.json({ default_branch: 'main' })

    let match = (/^\/repository\/branches\/(.+)$/).exec(path)

    if (method === 'GET' && match)
      return heads.has(match[1]!) ? Response.json({ commit: { id: heads.get(match[1]!) } }) : Response.json({ message: '404 Branch Not Found' }, { status: 404 })

    match = (/^\/repository\/files\/(.+)$/).exec(path)

    if (method === 'GET' && match) {
      const file = branches.get('main')!.get(match[1]!)

      return file === undefined ? Response.json({ message: '404 File Not Found' }, { status: 404 }) : Response.json({ blob_id: fileVersion(file.content), last_commit_id: file.last })
    }

    if (method === 'POST' && path === '/repository/commits') {
      between?.(repo)

      const files = branches.get(body.branch)!
      const next = new Map(files)
      const id = `c${repo.commits.length + 1}`
      const refuse = (message: string) => Response.json({ message }, { status: 400 })

      for (const { action, file_path, previous_path, content, last_commit_id } of body.actions) {
        const source = action === 'move' ? previous_path! : file_path
        const current = next.get(source)

        if (action === 'create' && next.has(file_path))
          return refuse(`A file with this name already exists`)

        if (action !== 'create' && current === undefined)
          return refuse(`A file with this name doesn't exist`)

        if (action !== 'create' && current!.last !== last_commit_id)
          return refuse('You are attempting to update or delete a file that has changed since you started editing it')

        if (action === 'delete' || action === 'move')
          next.delete(source)

        if (action !== 'delete')
          next.set(file_path, { content: content ?? current!.content, last: id })
      }

      branches.set(body.branch, next)
      heads.set(body.branch, id)
      repo.commits.push(body)

      return Response.json({ id, web_url: `https://gitlab.com/me/site/-/commit/${id}` }, { status: 201 })
    }

    return Response.json({ message: 'unexpected' }, { status: 500 })
  }

  return { repo, saver: gitlab({ repo: 'me/site', branch: 'main', token: 't0k', fetch: request as typeof fetch }), request }
}

const change = { absolute: '/unused', message: 'content(posts): update hello', author: { name: 'Kay', email: 'kay@example.com' } }

describe('gitlab', () => {
  test('commits a file through one commit with the token, the message and the editor as author', async () => {
    const { repo, saver } = lab({ 'content/posts/hello world.md': 'old' })

    const done = await saver.save({ ...change, repoPath: 'content/posts/hello world.md', text: 'héllo', base: fileVersion('old') })

    expect(done).toEqual({ sha: 'c1', url: 'https://gitlab.com/me/site/-/commit/c1' })
    expect(repo.files('main')).toEqual({ 'content/posts/hello world.md': 'héllo' })
    expect(repo.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /repository/branches/main',
      'GET /repository/files/content/posts/hello world.md?ref=c0',
      'POST /repository/commits',
    ])
    expect(repo.sent[0]?.headers['private-token']).toBe('t0k')
    expect(repo.commits[0]).toEqual({
      branch: 'main',
      commit_message: 'content(posts): update hello',
      author_name: 'Kay',
      author_email: 'kay@example.com',
      actions: [{ action: 'update', file_path: 'content/posts/hello world.md', content: 'héllo', last_commit_id: 'c0' }],
    })
  })

  test('creates a file the branch lacks, deletes one it holds, and writes nothing to delete one already gone', async () => {
    const { repo, saver } = lab({ 'a.md': 'a' })

    await saver.save({ ...change, repoPath: 'b.md', text: 'b', base: null })
    await saver.save({ ...change, repoPath: 'a.md', text: undefined })
    expect(repo.files('main')).toEqual({ 'b.md': 'b' })

    const before = repo.sent.length

    expect(await saver.save({ ...change, repoPath: 'a.md', text: undefined })).toBeUndefined()
    expect(repo.sent.slice(before).map(({ method }) => method)).toEqual(['GET', 'GET'])
  })

  test('uses the default branch when none is given', async () => {
    const { repo, request } = lab({})
    const unnamed = gitlab({ repo: 'me/site', token: 't', fetch: request as typeof fetch })

    await unnamed.save({ ...change, repoPath: 'b.md', text: 'b' })
    expect(repo.files('main')).toEqual({ 'b.md': 'b' })
    expect(repo.sent[0]?.path).toBe('')
  })

  test('refuses a change made from another version, and a new file already there, writing nothing', async () => {
    const { repo, saver } = lab({ 'a.md': 'a' })
    const stale = await failureOf<SaveConflictError>(saver.save({ ...change, repoPath: 'a.md', text: 'mine', base: 'a11ce' }))
    const taken = await failureOf<SaveConflictError>(saver.save({ ...change, repoPath: 'a.md', text: 'mine', base: null }))

    expect(stale).toBeInstanceOf(SaveConflictError)
    expect(stale.current).toBe(fileVersion('a'))
    expect(taken.creating).toBe(true)
    expect(repo.files('main')).toEqual({ 'a.md': 'a' })
    expect(repo.commits).toHaveLength(0)
  })

  test('moves a file and rewrites its referrers in one commit', async () => {
    const { repo, saver } = lab({ 'old.md': 'o', 'ref.md': 'see old' })
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
    expect(repo.commits).toHaveLength(1)
    expect(repo.commits[0]?.actions[0]).toEqual({ action: 'move', previous_path: 'old.md', file_path: 'new.md', content: 'o2', last_commit_id: 'c0' })
    expect(saver.together).toBe(true)
  })

  test('refuses a move whose source is gone, target taken, or referrer saved since, writing nothing', async () => {
    const { repo, saver } = lab({ 'old.md': 'o', 'taken.md': 't', 'ref.md': 'r' })
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
    expect(repo.commits).toHaveLength(0)
  })

  test('reads again when a file changed between the read and the commit: the change is kept when it was another file, and a conflict when it was this one', async () => {
    let pushed = false
    const { repo, saver } = lab({ 'a.md': 'a', 'other.md': 'x' }, { between: (state) => {
      if (!pushed) {
        pushed = true
        state.push('main', 'a.md', 'theirs')
      }
    } })

    // The file saved changed under the commit: GitLab refuses it, the read finds the new version and the base no longer matches.
    const conflict = await failureOf<SaveConflictError>(saver.save({ ...change, repoPath: 'a.md', text: 'mine', base: fileVersion('a') }))

    expect(conflict).toBeInstanceOf(SaveConflictError)
    expect(conflict.current).toBe(fileVersion('theirs'))
    expect(repo.files('main')).toEqual({ 'a.md': 'theirs', 'other.md': 'x' })

    // With no base, the save is made again over what is there.
    pushed = false
    await saver.save({ ...change, repoPath: 'a.md', text: 'mine' })
    expect(repo.files('main')).toEqual({ 'a.md': 'mine', 'other.md': 'x' })
  })

  test('reports a file still changing after three tries as a conflict with no version', async () => {
    const { saver } = lab({ 'a.md': 'a' }, { between: state => state.push('main', 'a.md', crypto.randomUUID()) })
    const failure = await failureOf<SaveConflictError>(saver.save({ ...change, repoPath: 'a.md', text: 'mine' }))

    expect(failure).toBeInstanceOf(SaveConflictError)
    expect(failure.current).toBeUndefined()
  })

  test('throws what GitLab said when it refuses, whether as a message or an error', async () => {
    const withMessage = lab({}, { refuse: { method: 'GET', pattern: /branches/, response: Response.json({ message: '401 Unauthorized' }, { status: 401 }) } })
    const withError = lab({}, { refuse: { method: 'GET', pattern: /branches/, response: Response.json({ error: 'insufficient_scope' }, { status: 403 }) } })
    const failure = withMessage.saver.save({ ...change, repoPath: 'a.md', text: 'a' })

    await expect(failure).rejects.toBeInstanceOf(ForgeError)
    await expect(failure).rejects.toThrow('GitLab answered 401: 401 Unauthorized')
    await expect(withError.saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('GitLab answered 403: insufficient_scope')
  })

  test('does not retry a refusal that is not about a file having changed, such as a protected branch', async () => {
    const { repo, saver } = lab({}, { refuse: { method: 'POST', pattern: /commits/, response: Response.json({ message: 'You are not allowed to push into this branch' }, { status: 403 }) } })
    const failure = await failureOf<ForgeError>(saver.save({ ...change, repoPath: 'a.md', text: 'a' }))

    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure.message).toBe('GitLab answered 403: You are not allowed to push into this branch')
    expect(repo.sent.filter(({ method }) => method === 'POST')).toHaveLength(1)
  })

  test('says a save may have gone through when the commit is not answered, but not an earlier failure', async () => {
    const base = lab({})
    const unreachable = async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST')
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })

      return base.request(input, init)
    }
    const dropped = gitlab({ repo: 'me/site', branch: 'main', token: 't', fetch: unreachable as typeof fetch })
    const early = gitlab({ repo: 'me/site', branch: 'main', token: 't', fetch: (async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    }) as unknown as typeof fetch })

    await expect(dropped.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('Could not reach GitLab (ECONNRESET): the save may still have gone through')
    await expect(early.save({ ...change, repoPath: 'b.md', text: 'b' })).rejects.toThrow(/^Could not reach GitLab \(ECONNRESET\)$/)
  })

  test('fails a save GitLab does not answer within the timeout', async () => {
    const hanging = async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
    const saver = gitlab({ repo: 'me/site', branch: 'main', token: 't', timeout: '50ms', fetch: hanging as typeof fetch })

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('GitLab did not answer within 0.05 s')
    expect(() => gitlab({ repo: 'r', token: 't', timeout: 50 as never })).toThrow('kay: gitlab timeout is 50')
  })

  test('encodes the project path and the branch, and sends them to a self-managed address', async () => {
    const seen: string[] = []
    const saver = gitlab({ repo: 'group/sub/site', branch: 'a/b', token: 't', baseUrl: 'https://gl.example.com/', fetch: (async (input: string) => {
      seen.push(input)

      return Response.json({ commit: { id: 'c0' } })
    }) as unknown as typeof fetch })

    await saver.save({ ...change, repoPath: 'dir/x y.md', text: undefined })
    expect(seen[0]).toBe('https://gl.example.com/api/v4/projects/group%2Fsub%2Fsite/repository/branches/a%2Fb')
    expect(seen[1]).toBe('https://gl.example.com/api/v4/projects/group%2Fsub%2Fsite/repository/files/dir%2Fx%20y.md?ref=c0')
  })

  test('refuses a repository with no default branch when none is named', async () => {
    const saver = gitlab({ repo: 'me/site', token: 't', fetch: (async () => Response.json({ default_branch: null })) as unknown as typeof fetch })

    await expect(saver.save({ ...change, repoPath: 'a.md', text: 'a' })).rejects.toThrow('no default branch')
  })

  test('refuses a plain http address outside localhost, since the token travels in every request', () => {
    const make = (url: string) => () => gitlab({ baseUrl: url, repo: 'me/site', token: 't' })

    expect(make('http://gl.example.com')).toThrow('kay: gitlab baseUrl is \'http://gl.example.com\'')
    expect(make('http://localhost:3000')).not.toThrow()
    expect(make('https://gl.example.com')).not.toThrow()
  })
})
