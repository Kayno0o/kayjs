import type { AuthUser, PublicUser } from '@kayjs/auth'
import type { IconData } from '@kayjs/icons'
import type { KayChild } from '@kayjs/kay'
import type { ActiveI18nConfig } from '@kayjs/kay/config'
import type { KayLocals, RequestContext, StandardSchemaV1 } from '@kayjs/kay/server'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, memoryAuthStore } from '../../plugin-auth/src/index'
import { content, defineCollection } from '../../plugin-content/src/index'
import { Icon } from '../../plugin-icons/src/index'
import { createRooms } from '../../plugin-live/src/index'
import { mcp, mcpTool } from '../../plugin-mcp/src/index'
import { action } from '../src/server/action'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

type Expect<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

interface AppUser extends AuthUser {
  plan: 'free' | 'pro'
  orgId: string
}

interface SearchInput {
  query: string
  limit?: number | undefined
}

const searchSchema: StandardSchemaV1<SearchInput, SearchInput> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(raw) {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      if (typeof obj.query !== 'string')
        return { issues: [{ message: 'query required', path: ['query'] }] }
      return { value: { query: obj.query, limit: typeof obj.limit === 'number' ? obj.limit : undefined } }
    },
  },
}

interface PostFrontmatter {
  title: string
  published: boolean
}

const postSchema: StandardSchemaV1<unknown, PostFrontmatter> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(raw) {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      if (typeof obj.title !== 'string')
        return { issues: [{ message: 'title required', path: ['title'] }] }
      return { value: { title: obj.title, published: Boolean(obj.published) } }
    },
  },
}

describe('Plugin generics: @kayjs/auth, @kayjs/mcp, @kayjs/content (#3545)', () => {
  it('createAuth<TUser> preserves custom user fields across createUser, guard, exportUser, and getUser without casts', async () => {
    const store = memoryAuthStore<AppUser>()
    const auth = createAuth<AppUser>({
      store,
      requireEmailVerification: false,
      defaultUserFields: { plan: 'free', orgId: 'org-default' },
    })

    // createUser accepts & returns custom fields with passwordHash omitted
    const created = await auth.createUser({
      email: 'alice@example.com',
      password: 'super-secret-password-123',
      emailVerified: true,
      plan: 'pro',
      orgId: 'org-42',
    })

    type _CreatedIsPublicAppUser = Expect<Equal<typeof created, PublicUser<AppUser>>>
    const _ok1: _CreatedIsPublicAppUser = true
    expect(_ok1).toBe(true)
    expect(created.plan).toBe('pro')
    expect(created.orgId).toBe('org-42')
    // @ts-expect-error passwordHash must be stripped from PublicUser<AppUser>
    const _noHash = created.passwordHash
    expect(_noHash).toBeUndefined()

    // guard({ allow }) receives PublicUser<AppUser> without casts
    const proGuard = auth.guard({
      allow: (user) => {
        const _plan: 'free' | 'pro' = user.plan
        const _org: string = user.orgId
        return _plan === 'pro' && _org.length > 0
      },
    })
    expect(typeof proGuard).toBe('function')

    // End-to-end request: auth.getUser(ctx) returns PublicUser<AppUser> | undefined with custom fields intact
    const root = makeTemp('kay-auth-generic-')
    mkdirSync(join(root, 'src/routes'), { recursive: true })
    writeFileSync(join(root, 'src/routes/index.tsx'), 'export default function Home() { return <p>ok</p> }\n')

    let seenPlan: 'free' | 'pro' | undefined
    let seenOrg: string | undefined
    const probePlugin = {
      name: 'probe',
      server(api: import('@kayjs/kay/config').ServerPluginAPI) {
        api.route('GET', '/me', (ctx: RequestContext) => {
          const u = auth.getUser(ctx)
          seenPlan = u?.plan
          seenOrg = u?.orgId
          return ctx.json({ plan: u?.plan ?? null, orgId: u?.orgId ?? null })
        })
      },
    }

    const app = await testApp({ root, plugins: [auth, probePlugin] })
    const signin = await app.post('/auth/signin', {
      email: 'alice@example.com',
      password: 'super-secret-password-123',
    })
    expect(signin.status).toBe(200)
    const cookie = signin.headers.getSetCookie()[0]!.split(';')[0]!

    const meRes = await app.fetch('/me', { headers: { cookie } })
    expect(meRes.status).toBe(200)
    expect(await meRes.json()).toEqual({ plan: 'pro', orgId: 'org-42' })
    expect(seenPlan).toBe('pro')
    expect(seenOrg).toBe('org-42')

    const exported = await auth.exportUser(created.id)
    expect(exported?.user.plan).toBe('pro')
    expect(exported?.user.orgId).toBe('org-42')

    // Empty locals returns undefined typed as PublicUser<AppUser> | undefined
    const emptyLocals: KayLocals = {}
    const nobody = auth.getUser({ locals: emptyLocals })
    type _GetUserType = Expect<Equal<typeof nobody, PublicUser<AppUser> | undefined>>
    const _ok2: _GetUserType = true
    expect(_ok2).toBe(true)
    expect(nobody).toBeUndefined()

    auth.dispose()
  })

  it('MCP tools keep their input & output types into handler and format without any', () => {
    const searchAction = action(searchSchema, async (input) => {
      return { hits: [input.query], total: input.limit ?? 10 }
    })

    // 1. mcpTool() preserves strict Input/Output and schema output types
    const wrappedActionTool = mcpTool({
      action: searchAction,
      description: 'Search via action',
      format: (out, input) => {
        const _hits: string[] = out.hits
        const _q: string = input.query
        // @ts-expect-error unknown property on action output
        const _badOut = out.nope
        // @ts-expect-error unknown property on action input
        const _badIn = input.nope
        return `${_q}:${_hits.length}`
      },
    })

    const wrappedHandlerTool = mcpTool({
      description: 'Search via handler',
      schema: searchSchema,
      handler: (input) => {
        const _q: string = input.query
        const _limit: number | undefined = input.limit
        // @ts-expect-error unknown property on handler input
        const _bad = input.unknownField
        return { matched: _q, limit: _limit }
      },
      format: (out, input) => {
        const _m: string = out.matched
        const _q: string = input.query
        return `${_m}/${_q}`
      },
    })

    const schemalessHandlerTool = mcpTool({
      description: 'Ping',
      handler: (input) => {
        type _IsRecord = Expect<Equal<typeof input, Record<string, unknown>>>
        const _ok: _IsRecord = true
        return _ok ? 'pong' : 'fail'
      },
    })

    // 2. Inline tools directly inside mcp({ tools: { ... } }) also preserve input/output types
    const plugin = mcp({
      token: 'secret',
      tools: {
        wrappedActionTool,
        wrappedHandlerTool,
        schemalessHandlerTool,
        inlineAction: {
          action: searchAction,
          description: 'Inline action tool',
          format: (out, input) => {
            const _total: number = out.total
            const _q: string = input.query
            // @ts-expect-error unknown property on inline action input
            const _bad = input.missing
            return `${_q}:${_total}`
          },
        },
        inlineHandler: {
          description: 'Inline handler tool',
          schema: searchSchema,
          handler: (input) => {
            const _q: string = input.query
            // @ts-expect-error unknown property on inline handler input
            const _bad = input.missing
            return _q.toUpperCase()
          },
        },
      },
    })
    expect(plugin.name).toBe('@kayjs/mcp')
  })

  it('@kayjs/content enforces Record<string, unknown> without schema and eliminates any from content & MarkdownComponent', () => {
    const dir = makeTemp('kay-content-types-')
    writeFileSync(join(dir, 'hello.md'), '---\ntitle: Hello\npublished: true\n---\n\nBody text\n')

    function Callout({ title, children }: { title: string, children?: KayChild }) {
      return <aside><strong>{title}</strong>{children}</aside>
    }

    // 1. Collection without schema always types data as Record<string, unknown>
    const untyped = defineCollection({
      dir,
      components: { Callout },
    })
    const rawEntry = untyped.get('hello')
    expect(rawEntry).toBeDefined()
    type _UntypedData = Expect<Equal<NonNullable<typeof rawEntry>['data'], Record<string, unknown>>>
    const _okUntyped: _UntypedData = true
    expect(_okUntyped).toBe(true)

    // @ts-expect-error cannot pass explicit TData without a schema
    const _forbidden = defineCollection<PostFrontmatter>({ dir })
    expect(_forbidden).toBeDefined()

    // 2. Collection with schema types data as PostFrontmatter
    const posts = defineCollection({
      dir,
      schema: postSchema,
      components: { Callout },
    })
    const post = posts.get('hello')
    expect(post?.data.title).toBe('Hello')
    type _TypedData = Expect<Equal<NonNullable<typeof post>['data'], PostFrontmatter>>
    const _okTyped: _TypedData = true
    expect(_okTyped).toBe(true)

    // 3. content accepts heterogeneous collections and typed feeds without any
    const plugin = content({
      collections: [untyped, posts],
      feeds: [
        {
          title: 'Posts',
          description: 'Blog posts',
          site: 'https://example.com',
          collection: posts,
          mapItem: (entry) => {
            const _title: string = entry.data.title
            const _pub: boolean = entry.data.published
            // @ts-expect-error unknown property on feed entry data
            const _bad = entry.data.nope
            return { title: `${_title} (${_pub})` }
          },
        },
      ],
    })
    expect(plugin.name).toBe('@kayjs/content')
  })
})

describe('<Icon> props (#3592)', () => {
  it('takes the attributes of an <svg> and refuses a typo or a React spelling', () => {
    const arrow: IconData = { viewBox: '0 0 24 24', width: '1em', height: '1em', body: '<path d="M5 12h14"/>' }
    const elements = [
      <Icon icon={arrow} class="size-4" stroke-width="2" aria-label="Next" data-test="1" />,
      // @ts-expect-error Unknown attribute typo
      <Icon icon={arrow} clas="size-4" />,
      // @ts-expect-error React camelCase SVG attribute
      <Icon icon={arrow} strokeWidth="2" />,
    ]
    expect(elements).toHaveLength(3)
  })
})

describe('services are typed by their key (#3579)', () => {
  it('types what inject returns, and refuses a string key or a value of the wrong type', async () => {
    const { serviceKey, definePlugin, I18N_CONFIG_SERVICE } = await import('@kayjs/kay/config')
    const Greeting = serviceKey<{ text: string }>('test.greeting')
    let seen: { text: string } | undefined
    const plugin = definePlugin({
      name: 'typed-services',
      server(api) {
        api.provide(Greeting, { text: 'bonjour' })
        const got = api.inject(Greeting)
        const i18n = api.inject(I18N_CONFIG_SERVICE)
        type _Got = Expect<Equal<typeof got, { text: string } | undefined>>
        type _I18n = Expect<Equal<typeof i18n, ActiveI18nConfig | undefined>>
        const typed: [_Got, _I18n] = [true, true]
        void typed
        seen = got
        // @ts-expect-error a value that does not match the key's type
        api.provide(Greeting, { text: 1 })
        // @ts-expect-error a bare string is not a service key
        api.inject('test.greeting')
      },
    })
    // @ts-expect-error plugins release their state through api.onShutdown, not a dispose hook
    definePlugin({ name: 'old-dispose', dispose() {} })

    const root = makeTemp('kay-typed-services-')
    mkdirSync(join(root, 'src/routes'), { recursive: true })
    writeFileSync(join(root, 'src/routes/index.tsx'), 'export default function Home() { return <p>ok</p> }\n')
    await testApp({ root, plugins: [plugin] })
    expect(seen).toEqual({ text: 'bonjour' })
  })

  it('refuses a rooms endpoint without the member each stream joins as', () => {
    // @ts-expect-error `path` mounts an endpoint, which needs `member`
    expect(() => createRooms({ path: '/api/live' })).toThrow('@kayjs/live: createRooms({ path: \'/api/live\' }) needs member(ctx), the member each stream joins as')
    expect(createRooms({ pingMs: 0 } as never).name).toBe('@kayjs/live')
  })
})
