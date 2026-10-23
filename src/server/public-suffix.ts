import { PUBLIC_SUFFIX_RULES } from './public-suffixes'

interface Rules {
  plain: Set<string>
  wildcards: Set<string>
  exceptions: Set<string>
}

const NON_ASCII = /[^\0-\x7F]/
const RULE_MARK = /^(?:!|\*\.)/

let rules: Rules | undefined

// The Public Suffix List, read once when a wildcard needs it: its rules in punycode, as a URL's hostname is.
function loaded(): Rules {
  if (rules)
    return rules

  const found: Rules = { plain: new Set(), wildcards: new Set(), exceptions: new Set() }

  for (const line of new TextDecoder().decode(Bun.gunzipSync(Buffer.from(PUBLIC_SUFFIX_RULES, 'base64'))).split('\n')) {
    const exception = line.startsWith('!')
    const wildcard = line.startsWith('*.')
    const name = line.replace(RULE_MARK, '')
    const ascii = NON_ASCII.test(name) ? URL.parse(`http://${name}`)?.hostname : name
    const into = exception ? found.exceptions : found.plain

    if (ascii !== undefined)
      (wildcard ? found.wildcards : into).add(ascii)
  }

  return rules = found
}

// Whether `domain` is a public suffix: a name under which anyone can register or deploy a subdomain, `com`, `co.uk` or `vercel.app`, by the Public Suffix List.
// A name the list does not know counts as one label long, as the list's own algorithm has it.
export function isPublicSuffix(domain: string): boolean {
  const { plain, wildcards, exceptions } = loaded()
  const labels = domain.toLowerCase().split('.')
  let length = 1

  for (let at = 0; at < labels.length; at++) {
    if (exceptions.has(labels.slice(at).join('.'))) {
      length = labels.length - at - 1

      return labels.length <= length
    }
  }

  for (let at = 0; at < labels.length; at++) {
    if (plain.has(labels.slice(at).join('.')) || (at + 1 < labels.length && wildcards.has(labels.slice(at + 1).join('.')))) {
      length = labels.length - at

      break
    }
  }

  return labels.length <= length
}
