// Drives an app that uses one feature of kayjs-auth, or none, then prints the node_modules packages and the kayjs-auth modules that were loaded: `bun loaded.ts <scenario>`.
import { discordProvider } from '../../src/oauth/providers'
import { authPages } from '../../src/pages'
import { testApp } from '../helpers/app'
import '../../src/index'

const PASSWORD = 'correct horse battery'
const SITE = 'https://site.test'
const PACKAGE_PATH = /node_modules\/((?:@[^/]+\/)?[^/]+)/
const SOURCE_PATH = /packages\/auth\/src\/(.+)$/

async function signedIn(app: { browser: ReturnType<typeof testApp>['browser'] }) {
  const visitor = app.browser()

  await visitor.call('register', { email: 'ada@example.com', password: PASSWORD })

  return visitor
}

const scenarios: Record<string, () => Promise<void>> = {
  // Registers and reads the user, with every feature left at its default.
  async minimal() {
    const visitor = testApp().browser()

    await visitor.call('register', { email: 'ada@example.com', password: PASSWORD })
    await visitor.json('/me')
  },
  // The default app with the prebuilt pages, probed on a provider route it does not have.
  async pages() {
    const visitor = testApp({ pages: authPages() }).browser()

    await visitor.fetch('/auth/nope/callback')
    await visitor.fetch('/auth/nope')
  },
  // A request carrying a bearer token loads the token code by itself, issuing none.
  async bearer() {
    await testApp().browser().fetch('/me', { headers: { authorization: 'Bearer unknown' } })
  },
  // A bearer token the app issued itself, then used for a request.
  async bearerIssued() {
    const app = testApp()
    const { user } = await app.browser().callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })
    const issued = await app.auth.issueToken(user.id, 'Kitchen display')

    await app.browser().fetch('/me', { headers: { authorization: `Bearer ${issued.ok ? issued.token : ''}` } })
  },
  // Configured and never asked, then asked for its return page only.
  async forwardUnused() {
    const visitor = testApp({ url: SITE, forwardAuth: 'example.test' }).browser()

    await visitor.json('/me')
  },
  async forwardReturn() {
    const visitor = testApp({ url: SITE, forwardAuth: 'example.test' }).browser()

    await visitor.fetch(`/auth/forward/return?to=${encodeURIComponent('https://app.example.test/')}`)
  },
  // Every switchable feature off, each method calling the closed door.
  async switchesOff() {
    const app = testApp({ url: SITE, passkeys: false, twoFactor: false, password: false, magicLink: false })
    const visitor = app.browser()

    await visitor.call('signInWithPassword', { identifier: 'ada@example.com', password: PASSWORD })
    await visitor.call('signInWithMagicLink', 'token')
    await visitor.call('setUpTwoFactor', { password: PASSWORD })
    await visitor.call('enableTwoFactor', '123456')
    await visitor.call('signInWithPasskey', {} as never)
    await visitor.call('changePassword', { password: PASSWORD }, PASSWORD)
  },
  async forwardAuth() {
    const visitor = testApp({ url: SITE, forwardAuth: 'example.test' }).browser()

    await visitor.fetch('/auth/forward')
  },
  async passkeys() {
    const visitor = await signedIn(testApp({ url: SITE }))

    await visitor.call('passkeySignInOptions')
  },
  async twoFactor() {
    const visitor = await signedIn(testApp())

    await visitor.call('setUpTwoFactor', { password: PASSWORD })
  },
  async organizations() {
    const visitor = await signedIn(testApp({ organizations: { roles: { owner: [], member: [] }, owner: 'owner' } }))

    await visitor.call('createOrganization', { name: 'Acme' })
  },
  async admin() {
    const visitor = await signedIn(testApp({ admin: 'admin' }))

    await visitor.call('listUsers')
  },
  async oauth() {
    const visitor = testApp({ url: SITE, oauth: { discord: { provider: discordProvider(), clientId: 'id', clientSecret: 'secret' } } }).browser()

    await visitor.fetch('/auth/discord')
  },
  async oauthServer() {
    const visitor = testApp({ url: SITE, pages: authPages(), scopes: ['posts:read'] }).browser()

    await visitor.fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:33418/callback'] }) })
  },
}

const scenario = process.argv[2] ?? 'minimal'

await scenarios[scenario]!()

const paths = Object.keys(require.cache)

console.log(JSON.stringify({
  packages: [...new Set(paths.map(path => PACKAGE_PATH.exec(path)?.[1]).filter(Boolean))],
  modules: paths.map(path => SOURCE_PATH.exec(path)?.[1]).filter(Boolean),
}))
