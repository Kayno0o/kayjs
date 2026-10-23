const MAX_ADDRESS = 254
const MAX_LOCAL = 64
const MAX_LABEL = 63
// RFC 5322's atext, with the letters and digits of any script, the dot apart: a local part has no quote, space, comma, angle bracket or parenthesis.
const LOCAL = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const HOST_FORBIDDEN = /[\s/?#@:\\[\]%\p{Cc}]/u
const NUMERIC = /^\d+$/

// The form an address is stored and compared in: Unicode normalised, trimmed, in lower case, its domain in punycode. Undefined for anything that is not one plain address: a second `@`, a comma list, a line break, a name with angle brackets, a domain without a dot, an IP.
// `+tag` stays part of the address, as providers treat it as theirs.
export function normalizeAddress(input: unknown): string | undefined {
  if (typeof input !== 'string')
    return undefined

  const text = input.normalize('NFC').trim()
  const at = text.indexOf('@')

  if (text.length > MAX_ADDRESS || at < 1 || at !== text.lastIndexOf('@'))
    return undefined

  const local = text.slice(0, at).toLowerCase()
  const raw = text.slice(at + 1)

  if (local.length > MAX_LOCAL || !LOCAL.test(local) || raw === '' || HOST_FORBIDDEN.test(raw))
    return undefined

  const host = URL.parse(`http://${raw}`)?.hostname

  if (host === undefined || host === '' || host.length > MAX_ADDRESS - at - 1)
    return undefined

  const labels = host.split('.')
  const last = labels.at(-1)!

  if (labels.length < 2 || NUMERIC.test(last) || labels.some(label => label.length > MAX_LABEL || !LABEL.test(label)))
    return undefined

  const address = `${local}@${host}`

  return address.length > MAX_ADDRESS ? undefined : address
}
