import { URL_ATTRIBUTES } from './url-attributes'
// A browser drops tabs and line breaks anywhere in a URL, and spaces and control characters before it.
const SKIPPED = /^[\0-\x20]+|[\t\n\r]/g
const SCRIPT_URL = /^(?:javascript|vbscript):|^data:\s*text\/html/i

// A bound URL that would run script or render a page of its own, such as a user's `javascript:alert(1)` link, goes out as `unsafe:javascript:alert(1)`, which a browser does nothing with, whatever the CSP says.
export function safeUrl(name: string, value: string): string {
  return URL_ATTRIBUTES.includes(name.toLowerCase()) && SCRIPT_URL.test(value.replace(SKIPPED, '')) ? `unsafe:${value}` : value
}
