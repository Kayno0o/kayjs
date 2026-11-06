// Every value `kay` exports, which a component script and a server fence use with no import: the compiler imports the ones a file reads without declaring or importing a name of its own.
// Each is `browser` when a component using it needs the browser (state, effects, lifecycle, browser readings, navigation), which makes the component an island, or `shared` when it computes the same on both sides, so a component using only those stays static.
// `tests/llms.test.ts` holds this table to the exports of `kay`.
export type KayRole = 'browser' | 'shared'

export const KAY_ROLES: Readonly<Record<string, KayRole>> = {
  ActionError: 'shared',
  ActionRedirectError: 'shared',
  ApiError: 'shared',
  action: 'browser',
  apiUrl: 'shared',
  batch: 'browser',
  byteCount: 'shared',
  carrySchema: 'browser',
  call: 'browser',
  context: 'browser',
  createContext: 'browser',
  ctx: 'shared',
  debounced: 'browser',
  defer: 'shared',
  defineUi: 'shared',
  describeField: 'shared',
  dispatch: 'browser',
  durationMs: 'shared',
  editing: 'browser',
  effect: 'browser',
  elementSize: 'browser',
  escapeHtml: 'shared',
  every: 'browser',
  flush: 'browser',
  focusInvalid: 'browser',
  followLog: 'browser',
  formErrors: 'shared',
  guard: 'browser',
  guardLeave: 'browser',
  installPrompt: 'browser',
  isEmail: 'shared',
  jobs: 'browser',
  linked: 'browser',
  listen: 'browser',
  live: 'browser',
  local: 'browser',
  localPath: 'shared',
  logFrom: 'browser',
  markInvalid: 'browser',
  mediaQuery: 'browser',
  memo: 'browser',
  mount: 'browser',
  navigate: 'browser',
  navigation: 'browser',
  onBeforeNavigate: 'browser',
  onCleanup: 'browser',
  onMount: 'browser',
  onNavigate: 'browser',
  optimistic: 'browser',
  persisted: 'browser',
  postedChecked: 'shared',
  postedValue: 'shared',
  postedValues: 'shared',
  presence: 'browser',
  previewing: 'browser',
  publicEnv: 'shared',
  queryParam: 'browser',
  randomId: 'browser',
  recipe: 'shared',
  reducedMotion: 'browser',
  refresh: 'browser',
  refuse: 'browser',
  resource: 'browser',
  root: 'browser',
  route: 'shared',
  s: 'shared',
  sanitizeHtml: 'shared',
  searchResults: 'browser',
  searchSite: 'browser',
  selection: 'browser',
  shortcut: 'browser',
  signal: 'browser',
  snapshot: 'browser',
  socket: 'browser',
  store: 'browser',
  stream: 'browser',
  trustHtml: 'shared',
  uid: 'shared',
  untrack: 'browser',
  watch: 'browser',
  webPush: 'browser',
  withBase: 'shared',
  withQuery: 'shared',
}

// What `kay/i18n` exports that needs the browser; the rest of it reads the locale alike on both sides.
export const I18N_ROLES: Readonly<Record<string, KayRole>> = {
  relativeTime: 'browser',
}

export const KAY_VALUES: readonly string[] = Object.keys(KAY_ROLES)

// Whether an import of `source` named `imported` needs the browser: any name of `kay` the table does not mark shared, and the browser names of `kay/i18n`.
export function needsBrowser(source: string, imported: string): boolean {
  if (source === 'kay')
    return KAY_ROLES[imported] !== 'shared'

  return source === 'kay/i18n' && I18N_ROLES[imported] === 'browser'
}
