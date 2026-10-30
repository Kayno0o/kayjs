import { kayLog } from '../runtime/log'
import { NEVER_SCHEMES } from '../runtime/url'
import { onUnsafeUrl } from '../runtime/url-report'
import { currentRequest } from './log'
import { requestUrl } from './request-url'

const SHOWN = 100
const REPORTED_CAP = 500
const reported = new Set<string>()

const cut = (text: string): string => text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text

// `kay dev` says once per attribute, URL and page when a bound URL was rewritten to `unsafe:`, as a link of the app's own scheme otherwise does nothing with no word.
// A dev config reload runs it again, starting the count over: a scheme the reload stops trusting is logged afresh.
export function reportUnsafeUrls(): void {
  reported.clear()
  onUnsafeUrl((attribute, url, scheme) => {
    const request = currentRequest()
    const page = request ? cut(requestUrl(request).pathname) : 'a page'
    const shown = JSON.stringify(cut(url))
    const key = `${attribute} ${shown} ${page}`

    if (reported.has(key) || reported.size >= REPORTED_CAP)
      return

    reported.add(key)
    kayLog('warn', `${page}: the bound ${attribute} ${shown} was rewritten to unsafe:, as its scheme '${scheme}:' is not one kay links to${NEVER_SCHEMES.test(scheme) ? ' and none may' : `; if the app trusts it, list it in links: { schemes: ['${scheme}'] } in kay.config.ts`}`)
  })
}
