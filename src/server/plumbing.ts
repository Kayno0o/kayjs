import { ASSET_PREFIX } from '../build/assets'
import { CARD_ROUTE, FILES_ROUTE, IMAGE_ROUTE, IMPORTED, VARIANTS } from '../runtime/image'
import { LIVE_ROUTE } from '../runtime/live-value'
import { SEARCH_DIR, SEARCH_MANIFEST } from '../runtime/search'
import { DRAFT_ROUTE } from '../runtime/swap'
import { ACTION_PREFIX } from '../runtime/wire'
import { ANALYTICS_PATH, ANALYTICS_SCRIPT_PATH, CUSTOM_COLLECT_PATH, CUSTOM_SCRIPT_PATH, NOTICE_SCRIPT_PATH } from './analytics'
import { PUBLIC_ENV_PATH } from './env-state'
import { ERROR_REPORTS } from './errors'
import { PREVIEW_ROUTE } from './preview'
import { CSP_REPORTS } from './violations'

// One of kay's own endpoints the Routes tab lists apart from the pages one visits.
export interface Plumbing {
  method: string
  // As the router reads it, a final `*` standing for the rest of the path; the actions' is written as their URLs are.
  path: string
  purpose: string
  // Where it is documented, a path of the docs site.
  docs: string
}

// What decides which of them the running app serves.
export interface PlumbingServed {
  // Whether any page or layout exports an action.
  actions: boolean
  publicEnv: boolean
  preview: boolean
  cspReports: boolean
  // The URLs of the browser build's files.
  buildFiles: Iterable<string>
  // The routes the extensions' server plugins mounted.
  mounted: { method: string, path: string }[]
}

interface Known extends Plumbing {
  // The path the router holds it at, when it is written otherwise above.
  route?: string
  when: (served: PlumbingServed, files: string[]) => boolean
}

const NOTICES = `${ASSET_PREFIX}THIRD-PARTY-LICENSES.txt`
const always = () => true
const mounted = (method: string, path: string) => (served: PlumbingServed) => served.mounted.some(route => route.method === method && route.path === path)
const built = (prefix: string) => (_: PlumbingServed, files: string[]) => files.some(file => file.startsWith(prefix))

// In the order the tab lists them.
const KNOWN: Known[] = [
  { method: 'GET', path: `${ASSET_PREFIX}*`, purpose: 'the browser build: islands, styles and fonts', docs: '/llms/build-and-start', when: always },
  { method: 'GET', path: `${IMPORTED}*`, purpose: 'imported files, named after their content', docs: '/llms/styles-and-assets', when: built(IMPORTED) },
  { method: 'GET', path: `${VARIANTS}*`, purpose: 'the image variants the build wrote', docs: '/llms/images', when: built(VARIANTS) },
  { method: 'GET', path: IMAGE_ROUTE, purpose: 'resized images, by width and crop', docs: '/llms/images', when: always },
  { method: 'GET', path: CARD_ROUTE, purpose: 'share cards, drawn on the first request', docs: '/llms/images', when: always },
  { method: 'GET', path: `${FILES_ROUTE}*`, purpose: 'stored files, a private one to a signed link', docs: '/llms/files', when: always },
  { method: 'POST', path: `${ACTION_PREFIX}<file>/<name>`, route: `${ACTION_PREFIX}*`, purpose: 'a page or layout\'s actions', docs: '/llms/actions', when: served => served.actions },
  { method: 'POST', path: LIVE_ROUTE, purpose: 'live values: one connection per tab', docs: '/llms/api-from-islands', when: always },
  { method: 'POST', path: ERROR_REPORTS, purpose: 'the errors islands meet in the browser', docs: '/llms/islands', when: always },
  { method: 'POST', path: CSP_REPORTS, purpose: 'what the Content-Security-Policy blocked, with `security.reports`', docs: '/llms/proxy-and-security', when: served => served.cspReports },
  { method: 'GET', path: PREVIEW_ROUTE, purpose: 'enters preview mode from a signed link', docs: '/llms/content-cms', when: served => served.preview },
  { method: 'POST', path: DRAFT_ROUTE, purpose: 'a page rendered with the drafts an editor has not saved', docs: '/llms/content-cms', when: served => served.preview },
  { method: 'GET', path: PUBLIC_ENV_PATH, purpose: 'the variables `publicEnv` sends the browser', docs: '/llms/server', when: served => served.publicEnv },
  { method: 'GET', path: SEARCH_MANIFEST, purpose: 'the site search\'s index, which names its chunks', docs: '/llms/sitemap-search-fonts', when: (_, files) => files.includes(SEARCH_MANIFEST) },
  { method: 'GET', path: `${SEARCH_DIR}*`, purpose: 'the site search\'s index chunks', docs: '/llms/sitemap-search-fonts', when: built(SEARCH_DIR) },
  { method: 'GET', path: ANALYTICS_SCRIPT_PATH, purpose: 'the visit counter, served from the app', docs: '/llms/privacy', when: mounted('GET', ANALYTICS_SCRIPT_PATH) },
  { method: 'GET', path: NOTICE_SCRIPT_PATH, purpose: 'the analytics consent notice', docs: '/llms/privacy', when: mounted('GET', NOTICE_SCRIPT_PATH) },
  { method: 'POST', path: ANALYTICS_PATH, purpose: 'visits, passed on to the analytics provider', docs: '/llms/privacy', when: mounted('POST', ANALYTICS_PATH) },
  { method: 'GET', path: CUSTOM_SCRIPT_PATH, purpose: 'the custom tracker\'s script, pointed at the app', docs: '/llms/privacy', when: mounted('GET', CUSTOM_SCRIPT_PATH) },
  { method: 'POST', path: CUSTOM_COLLECT_PATH, purpose: 'the custom tracker\'s data, passed on', docs: '/llms/privacy', when: mounted('POST', CUSTOM_COLLECT_PATH) },
  { method: 'GET', path: NOTICES, purpose: 'the licences of the code the browser build bundles', docs: '/llms/build-and-start', when: (_, files) => files.includes(NOTICES) },
]

// The endpoints of kay's own the running app serves, without those an app file took over: `taken` says whether one holds a router path for a method.
export function plumbing(served: PlumbingServed, taken: (path: string, method: string) => boolean = () => false): Plumbing[] {
  const files = [...served.buildFiles]

  return KNOWN.filter(known => known.when(served, files) && !taken(known.route ?? known.path, known.method)).map(({ method, path, purpose, docs }) => ({ method, path, purpose, docs }))
}
