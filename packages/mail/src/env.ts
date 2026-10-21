import process from 'node:process'
import { configError, configuredSite } from 'kay/library'
import { log } from './log'

// Names kayjs-mail read before 1.70, each now read under its new name; the old ones still work, with a warning, until 1.73.
const RENAMED = {
  SMTP_INSECURE: 'MAIL_INSECURE',
  SMTP_DKIM_SELECTOR: 'MAIL_DKIM_SELECTOR',
  SMTP_DKIM_PRIVATE_KEY: 'MAIL_DKIM_PRIVATE_KEY',
  SMTP_DKIM_DOMAIN: 'MAIL_DKIM_DOMAIN',
  SMTP_FROM: 'MAIL_FROM',
} as const

const DEFAULT_PORT = 465
const LEADING_WWW = /^www\./u

const warned = new Set<string>()

function set(name: string): string | undefined {
  const value = process.env[name]

  return value === undefined || value === '' ? undefined : value
}

// The server, the port and the login that `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` held, written as the `MAIL_URL` that replaces them.
function urlOfLegacy(): string | undefined {
  const host = set('SMTP_HOST')

  if (host === undefined)
    return undefined

  const [user, pass] = [set('SMTP_USER'), set('SMTP_PASS')]
  const login = user === undefined && pass === undefined ? '' : `${encodeURIComponent(user ?? '')}${pass === undefined ? '' : `:${encodeURIComponent(pass)}`}@`

  return `smtp://${login}${host}:${set('SMTP_PORT') ?? DEFAULT_PORT}`
}

// Reads the pre-1.70 names into the new ones in `process.env` when the new one is not set, saying once which to rename, so everything after reads the new names alone.
export function adoptLegacyEnv(): void {
  const used: string[] = []

  for (const [old, name] of Object.entries(RENAMED)) {
    const value = process.env[old]

    if (value === undefined)
      continue

    used.push(`${old} to ${name}`)
    process.env[name] ??= value
  }

  const legacy = urlOfLegacy()

  if (legacy !== undefined) {
    used.push('SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS to MAIL_URL, such as smtp://user:pass@mail.example.com:465')

    if (set('MAIL_URL') === undefined)
      process.env.MAIL_URL = legacy
  }
  else if (set('SMTP_USER') !== undefined || set('SMTP_PASS') !== undefined) {
    used.push('SMTP_USER and SMTP_PASS to the login of MAIL_URL')
  }

  const fresh = used.filter(line => !warned.has(line))

  if (fresh.length === 0)
    return

  for (const line of fresh)
    warned.add(line)

  log.warn(`the environment sets names kayjs-mail reads until 1.73 only: rename ${fresh.join('; ')}`)
}

export interface MailServer {
  host: string
  port: number
  user: string | undefined
  pass: string | undefined
}

// The server `MAIL_URL` names: `smtp://user:pass@host:port`, the login and the port optional, the port 465 when left out.
export function parseMailUrl(value: string): MailServer {
  const url = URL.parse(value)

  if (url === null || (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || url.hostname === '')
    throw configError('MAIL_URL is no SMTP server: write it as smtp://user:pass@mail.example.com:465, the login and the port optional, a password with special characters percent-encoded')

  const [user, pass] = [url.username === '' ? undefined : decodeURIComponent(url.username), url.password === '' ? undefined : decodeURIComponent(url.password)]

  if ((user === undefined) !== (pass === undefined))
    throw configError('the login in MAIL_URL needs a user and a password, written smtp://user:pass@host: give both, or neither for a server that needs no login')

  return { host: url.hostname, port: url.port === '' ? DEFAULT_PORT : Number(url.port), user, pass }
}

// The address a mail comes from when nothing sets one: `noreply@` the site's host, which has no `www.`. Undefined while the site is unset or has no domain to send from, such as `localhost`.
export function defaultSender(): string | undefined {
  const origin = configuredSite()?.origin

  if (origin === undefined)
    return undefined

  const host = URL.parse(origin)?.hostname.replace(LEADING_WWW, '')

  return host === undefined || !host.includes('.') ? undefined : `noreply@${host}`
}
