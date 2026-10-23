import { configError } from 'kay/library'

// A domain, or several: the sites behind the proxy are on them or on their subdomains.
export type ForwardDomains = string | string[]

export interface ForwardAuthOptions {
  domains: ForwardDomains
  // Refuses a user without two-factor, sending them to set it up on the account page, instead of letting a password alone open the sites. Off by default.
  requireTwoFactor?: boolean | undefined
}

export interface ForwardAuthCore {
  domains: string[]
  requireTwoFactor: boolean
}

const MAX_URL_LENGTH = 2048

// The domains `forwardAuth` names, each a hostname of two labels at least with no scheme, port or path, so one misspelt as `com` or `https://example.com/` stops the app at startup rather than opening a whole suffix or nothing. A public suffix of two labels (`co.uk`, `github.io`) passes: kay carries no suffix list, so naming the app's own domain is the app's to get right.
export function forwardOf(option: ForwardDomains | ForwardAuthOptions | undefined, twoFactor = true): ForwardAuthCore | undefined {
  if (option === undefined)
    return undefined

  const { domains, requireTwoFactor = false } = typeof option === 'string' || Array.isArray(option) ? { domains: option } : option
  const listed = (typeof domains === 'string' ? [domains] : domains).map(domain => domain.trim().toLowerCase())

  if (listed.length === 0)
    throw configError('`forwardAuth` needs at least one domain: `forwardAuth: \'example.com\'`')

  for (const domain of listed) {
    const labels = domain.split('.')
    const parsed = labels.length > 1 && labels.every(label => label !== '') ? URL.parse(`https://${domain}`) : null

    if (parsed === null || parsed.hostname !== domain)
      throw configError(`\`forwardAuth\` domain '${domain}' is not a hostname such as 'example.com': no scheme, port or path, and at least two labels`)
  }

  if (requireTwoFactor && !twoFactor)
    throw configError('`forwardAuth.requireTwoFactor` sends users to set two-factor up, which `twoFactor: false` switches off: turn one of them off')

  return { domains: listed, requireTwoFactor }
}

// Where to send the visitor once signed in: an https URL on one of `domains` or their subdomains, as the browser normalised it, else nothing. Credentials in the URL, another scheme, a lookalike host and a URL of the portal's own sites all fall to nothing.
export function returnTarget(to: string | null | undefined, domains: string[]): string | undefined {
  if (to === null || to === undefined || to === '' || to.length > MAX_URL_LENGTH)
    return undefined

  const url = URL.parse(to)

  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    return undefined

  return domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : undefined
}
