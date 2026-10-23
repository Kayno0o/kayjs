import { configError, configuredSite } from 'kay/library'

const DEFAULT_PORT = 465
const LEADING_WWW = /^www\./u

export interface MailServer {
  host: string
  port: number
  user: string | undefined
  pass: string | undefined
  // `smtps:` speaks TLS from the start on any port.
  secure: true | undefined
}

// The server `MAIL_URL` names: `smtp://user:pass@host:port`, the login and the port optional, the port 465 when left out. `smtps:` speaks TLS from the start on any port.
export function parseMailUrl(value: string): MailServer {
  const url = URL.parse(value)

  if (url === null || (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || url.hostname === '')
    throw configError('MAIL_URL is no SMTP server: write it as smtp://user:pass@mail.example.com:465, the login and the port optional, a password with special characters percent-encoded')

  let user: string | undefined
  let pass: string | undefined

  try {
    [user, pass] = [url.username === '' ? undefined : decodeURIComponent(url.username), url.password === '' ? undefined : decodeURIComponent(url.password)]
  }
  catch {
    throw configError('the login in MAIL_URL has a malformed percent-encoding: write a password with special characters percent-encoded, as %40 for @ and %25 for %')
  }

  if ((user === undefined) !== (pass === undefined))
    throw configError('the login in MAIL_URL needs a user and a password, written smtp://user:pass@host: give both, or neither for a server that needs no login')

  return { host: url.hostname, port: url.port === '' ? DEFAULT_PORT : Number(url.port), user, pass, secure: url.protocol === 'smtps:' ? true : undefined }
}

// The address a mail comes from when nothing sets one: `noreply@` the site's host, which has no `www.`. Undefined while the site is unset or has no domain to send from, such as `localhost`.
export function defaultSender(): string | undefined {
  const origin = configuredSite()?.origin

  if (origin === undefined)
    return undefined

  const host = URL.parse(origin)?.hostname.replace(LEADING_WWW, '')

  return host === undefined || !host.includes('.') ? undefined : `noreply@${host}`
}
