// The statuses a `_<status>.kay` file in the routes directory renders a page for, in place of `_error.kay`.
export const STATUS_PAGES = [401, 403, 429, 503] as const

export type StatusPage = (typeof STATUS_PAGES)[number]

export function statusPageFile(status: number): string {
  return `_${status}.kay`
}

// Every file name of a status page: `_401.kay`, `_403.kay`, `_429.kay` and `_503.kay`.
export const STATUS_PAGE_FILES: ReadonlySet<string> = new Set(STATUS_PAGES.map(statusPageFile))
