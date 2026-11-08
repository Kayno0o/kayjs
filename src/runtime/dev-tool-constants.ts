// The addresses, storage keys and patterns the parts of the dev tool share. Split from dev-tool.ts, which the dev server serves with the modules it imports.

export const HOST = 'kay-dev'
export const STATE_KEY = 'kay-dev'
export const LAYOUT_KEY = 'kay-dev-layout'
export const CHECK_PROBLEMS = 'kay-check-problems'
// The type errors `kay dev` found, in a block of their own that the `types` event it sends rewrites.
export const TYPE_PROBLEMS = 'kay-type-problems'
export const TYPES_EVENT = 'kay-dev-types'
export const REQUEST = 'kay-dev-request'
export const HEAD_HEADER = 'x-kay-dev'
export const REQUEST_URL = '/_kay/dev/request'
export const STACK_URL = '/_kay/dev/stack'

// A stack frame in a chunk of the browser build, which the server can point at its `.kay` line.
export const CHUNK_FRAME = /\/_kay\/[\w.-]+\.js:\d+:\d+/

export const DEV_PATH = /\/_kay\/dev\//

// Shown first among the response headers.
export const FIRST_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'cache-control']
export const PRERENDER = { 'page': 'prerendered by kay build', 'listed': 'prerendered by kay build for the paths its setting lists', 'server islands': 'prerendered by kay build, its server islands rendered on request' }
