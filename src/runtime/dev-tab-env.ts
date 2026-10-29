import type { DevTab, DevTool } from './dev-tool'

// The Env tab's code, fetched at once as its badge counts the variables that look like secrets, with the tool's shared helpers from `tool.kit`.
const ENV_URL = '/_kay/env.js'
const MODULE_START = 'export default '
const BUILT_EVENT = 'kay-dev-built'

// Names a variable of a secret goes by, and the shapes of the values of one: a URL carrying a password, a token with a well-known prefix, a long run of random-looking characters.
const SECRET_NAME = /SECRET|PASSW(?:OR)?D|PRIVATE|TOKEN|CREDENTIAL|AUTH_?(?:KEY|TOKEN|SECRET)|(?:^|_)(?:DATABASE|DB|POSTGRES|PG|MYSQL|REDIS|MONGO(?:DB)?)_URL$/i
// A key may be public by design (a map or analytics key), so its name alone only calls for a look.
const KEY_NAME = /(?:^|_)KEY$/i
const PUBLIC_NAME = /PUBLIC|PUBLISHABLE/i
const SECRET_PREFIX = /^(?:sk|rk)_(?:live|test)_|^sk-|^gh[pousr]_|^github_pat_|^glpat-|^npm_|^SG\.|^xox[abprs]-|^AKIA[0-9A-Z]{16}|^eyJ[\w-]+\.[\w-]+\.|^-----BEGIN /
const URL_PASSWORD = /^[a-z][\w+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const HEX_SECRET = /^[0-9a-f]{32,}$/i
const RANDOM_LIKE = /^[\w+/=.-]{24,}$/
// Bits per character of a run of random base64 sits near 5; words and paths stay under 4.
const RANDOM_ENTROPY = 4

function entropy(value: string): number {
  const counts = new Map<string, number>()

  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1)

  return -[...counts.values()].reduce((sum, count) => sum + count / value.length * Math.log2(count / value.length), 0)
}

// Why a public variable looks like a secret, if it does; `maybe` when only its name is a key's, which may be public by design.
function secretReason(name: string, value: unknown): { reason: string, maybe: boolean } | undefined {
  if (SECRET_NAME.test(name))
    return { reason: 'its name looks like a secret', maybe: false }

  if (typeof value === 'string') {
    if (URL_PASSWORD.test(value))
      return { reason: 'its value is a URL with a password', maybe: false }

    if (SECRET_PREFIX.test(value))
      return { reason: 'its value looks like a token', maybe: false }

    if (HEX_SECRET.test(value))
      return { reason: 'its value is a long hexadecimal string, like a token', maybe: false }

    // A path or a URL has slashes in the places a base64 string has none.
    if (RANDOM_LIKE.test(value) && !value.startsWith('/') && !value.includes('://') && entropy(value) >= RANDOM_ENTROPY)
      return { reason: 'its value looks random, like a key', maybe: false }
  }

  return KEY_NAME.test(name) && !PUBLIC_NAME.test(name) ? { reason: 'its name is a key\'s, which is fine if the key is public by design, such as a map\'s', maybe: true } : undefined
}

// The variables `publicEnv` sends every visitor, read from the module the browser loads, so a secret declared public is seen; fetched as the tab shows and again after each restart.
export default function envTab(tool: DevTool, tab: DevTab): () => void {
  const { copyButton, entry, filterable, ownFetch, signal, toolbar } = tool.kit
  const win = tool.root.ownerDocument.defaultView!
  let reread: () => void = () => undefined
  const content = tool.make('div', 'stack')
  const bar = toolbar('Filter by name or value', () => bar.apply(content))
  let asked = 0
  const read = async () => {
    const ask = ++asked
    let values: Record<string, unknown> | undefined
    let failure: string | undefined

    try {
      const response = await ownFetch(win, ENV_URL, { cache: 'no-store' })

      // The route is there only when a field is `s.Public`; any other answer is a failure to read it.
      if (response.status !== 404) {
        if (!response.ok)
          throw new Error(`the server answered ${response.status}`)

        const text = await response.text()

        if (!(response.headers.get('content-type') ?? '').includes('javascript') || !text.startsWith(MODULE_START))
          throw new Error('the module is not the one kay sends')

        values = JSON.parse(text.slice(MODULE_START.length)) as Record<string, unknown>
      }
    }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (ask !== asked)
      return

    bar.element.hidden = values === undefined || Object.keys(values).length === 0

    if (failure !== undefined) {
      tab.count(0)
      content.replaceChildren(tool.make('div', 'empty', `Could not read the public env: ${failure}`))

      return
    }

    if (values === undefined) {
      tab.count(0)
      content.replaceChildren(tool.make('div', 'empty', 'This app sends no public env to the browser: no `defineEnv` field is `s.Public`.'))

      return
    }

    const entries = Object.entries(values)
    const list = tool.make('div')
    let flagged = 0

    for (const [name, value] of entries) {
      const found = secretReason(name, value)
      const secret = found !== undefined && !found.maybe
      const shown = typeof value === 'string' ? value : JSON.stringify(value)

      if (secret)
        flagged++

      list.append(filterable(entry('env', {
        name,
        after: [tool.make('span', 'val', shown), copyButton(`the value of ${name}`, shown)],
        issues: secret ? [{ text: `Every visitor reads this, and ${found.reason}. Keep a secret in defineEnv, read on the server alone.`, tone: 'error', icon: 'lock' }] : [],
        note: found?.maybe === true ? `Every visitor reads this: ${found.reason}.` : undefined,
      }), `${name} ${shown}`))
    }

    tab.count(flagged, flagged > 0 ? 'error' : undefined)
    content.replaceChildren(tool.make('div', 'note', `${entries.length} variable${entries.length === 1 ? '' : 's'} sent to every visitor at ${ENV_URL}.`), entries.length === 0 ? tool.make('div', 'empty', 'The app sends no public env: no variable is `s.Public`.') : list, bar.empty)
    bar.apply(content)
  }

  reread = () => void read()
  tab.panel.append(bar.element, content)
  win.addEventListener(BUILT_EVENT, reread, { signal })
  reread()

  return () => reread()
}
