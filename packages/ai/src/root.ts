import { configError } from 'kay/library'

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/

function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_V4.test(hostname)
}

// A server's API root, checked once by the provider that uses it, when `openai()` or `anthropic()` is called or, for a root from the environment, when an ask first chooses it: it parses and is http(s), and plain http is for a loopback host or a network `insecure` says is trusted whenever a key goes with it. `name` is what the message points at, the variable or the option.
export function checkedRoot(root: string, name: string, key: string | undefined, insecure: boolean | undefined): string {
  if (!URL.canParse(root))
    throw configError(`${name} is not a URL; write it with its scheme, such as https://api.example.com/v1 or http://localhost:11434/v1`)

  const url = new URL(root)

  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw configError(`${name} must be an http or https URL, not ${url.protocol}`)

  if (url.protocol === 'http:' && key !== undefined && insecure !== true && !loopback(url.hostname))
    throw configError(`${name} is plain http to ${url.hostname} and a key would go out in clear; use https, or set AI_INSECURE=true (insecure: true) for a network you trust, such as a compose network`)

  return root
}
