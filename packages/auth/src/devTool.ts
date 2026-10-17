import type { DevTool } from 'kay/dev-tool'

// The dev tool's Auth tab, a browser module kay loads on dev pages: who the session is, with a sign-out.
const SESSION_URL = '/_kay/auth'

interface DevSession {
  user: { id: string, email: string | null, emailVerified: boolean, username: string | null, roles: string[], hasPassword: boolean, twoFactor: boolean, locale: string | null, guest: boolean } | null
  via: 'session' | 'bearer' | null
  signOut: string
}

function base(): string {
  return document.querySelector<HTMLMetaElement>('meta[name=kay-base]')?.content ?? ''
}

export default function authDevTool(tool: DevTool): void {
  let asked = 0
  const tab = tool.tab({ id: 'auth', label: 'Auth', icon: 'user-round', shown: () => void show() })
  const empty = (text: string) => {
    tab.count(0)
    tab.panel.replaceChildren(tool.make('div', 'empty', text))
  }

  async function show(): Promise<void> {
    const ask = ++asked
    let session: DevSession

    try {
      const response = await fetch(SESSION_URL, { cache: 'no-store' })

      if (response.status === 404) {
        if (ask === asked)
          empty('kayjs-auth answers here under `kay dev` alone.')

        return
      }

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      session = await response.json() as DevSession
    }
    catch (error) {
      if (ask === asked)
        empty(`Could not read the session: ${error instanceof Error ? error.message : String(error)}`)

      return
    }

    if (ask !== asked)
      return

    const { user } = session

    tab.count(user === null ? 0 : 1)

    if (user === null) {
      empty('Nobody is signed in.')

      return
    }

    const facts = tool.make('dl', 'facts')
    const rows: [string, string][] = [
      ['User', user.id],
      ['Email', user.email === null ? 'none' : `${user.email}${user.emailVerified ? '' : ' (not verified)'}`],
      ['Username', user.username ?? 'none'],
      ['Roles', user.roles.length === 0 ? 'none' : user.roles.join(', ')],
      ['Signed in by', session.via ?? 'nothing'],
      ['Password', user.hasPassword ? 'set' : 'none'],
      ['Two-factor', user.twoFactor ? 'on' : 'off'],
      ['Locale', user.locale ?? 'none'],
      ['Guest', user.guest ? 'yes' : 'no'],
    ]

    for (const [name, value] of rows)
      facts.append(tool.make('dt', '', name), tool.make('dd', 'mono', value))

    const out = tool.make('button', 'tool', 'Sign out')
    const actions = tool.make('div', 'actions')
    const leave = async () => {
      out.disabled = true

      try {
        // The route answers with a redirect, which the page reloads past.
        const response = await fetch(`${base()}${session.signOut}`, { method: 'POST', redirect: 'manual' })

        if (!response.ok && response.type !== 'opaqueredirect')
          throw new Error(`the server answered ${response.status}`)

        location.reload()
      }
      catch (error) {
        out.disabled = false
        actions.append(tool.make('span', 'error', `Could not sign out: ${error instanceof Error ? error.message : String(error)}`))
      }
    }

    out.type = 'button'
    out.addEventListener('click', () => void leave())
    actions.append(out)
    tab.panel.replaceChildren(actions, facts)
  }
}
