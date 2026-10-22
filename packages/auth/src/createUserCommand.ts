// `kay auth create-user`: makes a user from the terminal, asking the password without echo, for a site with `signUp: false` whose first user has no page to register on.
import type { KayCommand } from 'kay/library'
import type { UserMaker } from './pages'
import process from 'node:process'
import { setSite, siteWithBase } from 'kay/library'
import { CHECK_USER, LOAD_AUTH } from './pages'

const END_OF_INPUT = '\u0004'
const INTERRUPT = '\u0003'
const BACKSPACE = new Set(['\u007F', '\b'])
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\u001B(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])?/g
const LINE_END = new Set(['\r', '\n'])

// What a terminal in raw mode typed so far after `chunk`: backspace erases, Enter or Ctrl+D finishes, Ctrl+C cancels, and no other control character is kept.
export function typedSecret(value: string, chunk: string): { value: string, end?: 'done' | 'cancelled' } {
  let typed = value

  // An arrow or function key sends an escape sequence, which is no part of a password.
  for (const char of chunk.replaceAll(ESCAPE_SEQUENCE, '')) {
    if (LINE_END.has(char) || char === END_OF_INPUT)
      return { value: typed, end: 'done' }

    if (char === INTERRUPT)
      return { value: typed, end: 'cancelled' }

    if (BACKSPACE.has(char))
      typed = [...typed].slice(0, -1).join('')
    else if (char >= ' ')
      typed += char
  }

  return { value: typed }
}

// One line typed without an echo, the label written on stderr so a piped stdout stays clean. Cancelled with Ctrl+C, or when the input ends, closes or fails (a terminal that went away reads as an EIO error): undefined. The terminal is restored on SIGTERM too, which raw mode would otherwise leave typing without an echo.
export async function readFromTerminal(label: string): Promise<string | undefined> {
  const { stdin } = process
  const restore = () => {
    // A terminal that went away refuses to leave raw mode.
    try {
      stdin.setRawMode(false)
    }
    catch {}

    stdin.pause()
    process.stderr.write('\n')
  }
  const onTerminate = () => {
    restore()
    process.exit(143)
  }

  process.stderr.write(label)

  // A terminal that went away before the first read refuses raw mode.
  try {
    stdin.setRawMode(true)
  }
  catch {
    process.stderr.write('\n')

    return undefined
  }

  stdin.setEncoding('utf8')
  stdin.resume()
  process.once('SIGTERM', onTerminate)

  let finish: (typed: string | undefined) => void = () => undefined
  let value = ''
  const onData = (chunk: string) => {
    const typed = typedSecret(value, chunk)

    value = typed.value

    if (typed.end !== undefined)
      finish(typed.end === 'done' ? value : undefined)
  }
  const onEnd = () => finish(undefined)

  try {
    return await new Promise<string | undefined>((resolve) => {
      finish = resolve
      stdin.on('data', onData)
      stdin.once('end', onEnd)
      stdin.once('close', onEnd)
      stdin.once('error', onEnd)
    })
  }
  finally {
    stdin.off('data', onData)
    stdin.off('end', onEnd)
    stdin.off('close', onEnd)
    stdin.off('error', onEnd)
    process.off('SIGTERM', onTerminate)
    restore()
  }
}

// The first line of a piped stdin, as `echo "$PASSWORD" | kay auth create-user ada`.
async function readFromPipe(): Promise<string> {
  const [line = ''] = (await Bun.stdin.text()).split('\n')

  return line.endsWith('\r') ? line.slice(0, -1) : line
}

// Asks for the password twice on a terminal, as a typo nobody sees would lock the user out, or reads one line of a pipe. Undefined when cancelled or the two differ.
export async function readPassword(): Promise<string | undefined> {
  if (!process.stdin.isTTY)
    return readFromPipe()

  const first = await readFromTerminal('Password: ')

  if (first === undefined)
    return undefined

  const second = await readFromTerminal('Again: ')

  if (second !== first && second !== undefined)
    console.error('kay auth create-user: the two passwords differ')

  return second === first ? first : undefined
}

export function createUserCommand(ask: () => Promise<string | undefined>): KayCommand {
  return {
    usage: 'auth create-user <email or username> [--email <address>] [--username <name>] [--role <role>]... [--no-password]',
    options: {
      'email': { type: 'string' },
      'username': { type: 'string' },
      'role': { type: 'string', multiple: true },
      'no-password': { type: 'boolean' },
    },
    positionals: 1,
    run: async ({ values, positionals: [login] }, refuse, { config, root }) => {
      if (login === undefined || login === '')
        return refuse('auth create-user needs the email or the username to sign in with')

      const isEmail = login.includes('@')

      if (isEmail && values.email !== undefined)
        return refuse('auth create-user was given two emails: the one to sign in with, and --email')

      if (!isEmail && values.username !== undefined)
        return refuse('auth create-user was given two usernames: the one to sign in with, and --username')

      const loader = (config.extensions ?? []).map(extension => (extension as { [LOAD_AUTH]?: (root: string, extensions: string[]) => Promise<UserMaker> })[LOAD_AUTH]).find(load => load !== undefined)

      if (loader === undefined) {
        console.error('kay auth create-user: kay.config.ts lists no auth() to find the app\'s auth through')

        return 1
      }

      const email = isEmail ? login : values.email as string | undefined
      const username = isEmail ? values.username as string | undefined : login
      const roles = values.role as string[] | undefined

      // The site the app's auth reads while it loads, as the server sets it before it does.
      // A site or base the server refuses is refused here too, through the same reading.
      try {
        const site = siteWithBase(config.site, config.base)

        if (site !== undefined)
          setSite(site, config.trailingSlash)
      }
      catch (error) {
        console.error(`kay auth create-user: ${error instanceof Error ? error.message : String(error)}`)

        return 1
      }

      try {
        // The app's auth loads, and the login is checked, before a password is asked twice for a user that cannot be made.
        const auth = await loader(root, (config.extensions ?? []).map(extension => extension.name))
        const problems = await auth[CHECK_USER]({ ...email !== undefined && { email }, ...username !== undefined && { username }, ...roles && { roles } })

        if (Object.keys(problems).length > 0) {
          console.error(`kay auth create-user: refused: ${Object.entries(problems).map(([field, code]) => `${field} ${code}`).join(', ')}`)

          return 1
        }

        const password = values['no-password'] === true ? undefined : await ask()

        if (password === undefined && values['no-password'] !== true)
          return 1

        if (password === '') {
          console.error('kay auth create-user: no password given; pass --no-password for a user who signs in another way')

          return 1
        }

        // An address the operator types is vouched for: the user cannot receive a verification mail before they can sign in.
        const result = await auth.createUser({ ...email !== undefined && { email, emailVerified: true }, ...username !== undefined && { username }, ...password !== undefined && { password }, ...roles && { roles } })

        if (!result.ok) {
          console.error(`kay auth create-user: refused: ${Object.entries(result.errors).map(([field, code]) => `${field} ${code}`).join(', ')}`)

          return 1
        }

        console.log(`Created ${result.user.username ?? result.user.email ?? result.user.id}${result.user.roles.length > 0 ? ` (${result.user.roles.join(', ')})` : ''}.`)

        return 0
      }
      catch (error) {
        console.error(`kay auth create-user: ${error instanceof Error ? error.message : String(error)}`)

        return 1
      }
    },
  }
}

export default createUserCommand(readPassword)
