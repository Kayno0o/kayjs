import type { AuthSessionData } from '../../../src/auth'
import type { Mail } from '../../../src/mail'
import { session } from 'kay/server'
import { createAuth } from '../../../src/auth'
import { memoryStore } from '../../../src/memoryStore'
import { discordProvider } from '../../../src/oauth/providers'

const DIGIT = /\d/
const SECRET = 'a-fixture-secret-that-is-long-enough-for-kay'

// Every mail the site sends, read by the test.
export const mails: Mail[] = []

export const store = memoryStore()

// What the app keeps beside each user, by id.
export const profiles = new Map<string, Record<string, string>>()

export const auth = createAuth({
  sessions: session<AuthSessionData>({ secret: SECRET }),
  secret: SECRET,
  store,
  url: 'http://localhost',
  site: 'Fixture',
  scopes: ['notes:read', 'files.read'],
  forwardAuth: 'example.test',
  // A run of tests/variants.ts serves the fixture with the app's own credential rules.
  ...process.env.FIXTURE_RULES && { rules: { password: { min: 12, check: (value: string) => DIGIT.test(value) ? undefined : 'Add a digit.' }, username: { min: 3, max: 16 } } },
  pages: {
    // A run of tests/variants.ts serves the fixture with another landing page and another remember setting, through the environment.
    ...process.env.FIXTURE_HOME && { home: process.env.FIXTURE_HOME },
    ...(process.env.FIXTURE_REMEMBER === 'always' || process.env.FIXTURE_REMEMBER === 'never') && { remember: process.env.FIXTURE_REMEMBER },
    profile: {
      fields: { displayName: { label: 'Display name', required: true, maxLength: 20 }, bio: { label: { en: 'Bio', fr: 'Biographie' }, type: 'textarea' }, constructor: { label: 'Constructor' } },
      load: user => profiles.get(user.id) ?? {},
      save: (user, values) => {
        if (values.displayName === 'boom')
          throw new Error('profile store down')

        if (values.displayName === 'admin')
          return { errors: { displayName: 'Pick another name.' } }

        profiles.set(user.id, values)
        return undefined
      },
    },
  },
  oauth: { discord: { provider: discordProvider(), clientId: 'discord-id', clientSecret: 'discord-secret' } },
  email: {
    mailer: {
      send: (mail) => {
        mails.push(mail)
      },
    },
    requireVerified: false,
  },
  roles: { admin: [] },
  admin: 'admin',
  organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin' },
})
