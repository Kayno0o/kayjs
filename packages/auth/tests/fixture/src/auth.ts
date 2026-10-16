import type { AuthSessionData } from '../../../src/auth'
import type { Mail } from '../../../src/mail'
import { session } from 'kay/server'
import { createAuth } from '../../../src/auth'
import { memoryStore } from '../../../src/memoryStore'
import { discordProvider } from '../../../src/oauth/providers'

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
  pages: {
    profile: {
      fields: { displayName: { label: 'Display name', required: true, maxLength: 20 }, bio: { label: 'Bio', type: 'textarea' } },
      load: user => profiles.get(user.id) ?? {},
      save: (user, values) => {
        if (values.displayName === 'admin')
          return { errors: { displayName: 'Pick another name.' } }

        profiles.set(user.id, values)
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
