import type { DependencyChange } from './upgrade'

// What `kay upgrade` reads of an installed kay: its peers and which of them are optional.
export interface PeerManifest {
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const INDENT = /^\n?([ \t]+)"/m

// The optional peers an app installs itself (`typescript7`, `axe-core`, `@happy-dom/global-registrator`, `@kaynooo/pg-orm`), which kay no longer pulls in.
function optionalPeers(kay: PeerManifest | undefined): string[] {
  return Object.entries(kay?.peerDependenciesMeta ?? {}).filter(([, meta]) => meta.optional === true).map(([name]) => name)
}

// The optional peers of `kay` the app has installed (from its folder up) without declaring them: the ones it uses today only because an older kay installed them for it.
export async function undeclaredPeers(kay: PeerManifest | undefined, packageJson: Record<string, unknown>, installed: (name: string) => Promise<boolean>): Promise<string[]> {
  const declared = new Set(SECTIONS.flatMap(section => Object.keys((packageJson[section] ?? {}))))
  const found: string[] = []

  for (const name of optionalPeers(kay)) {
    if (!declared.has(name) && await installed(name))
      found.push(name)
  }

  return found
}

// What `addPeers` needs of the upgrade; `snapshot` and `restore` keep and put back package.json and the lockfile.
export interface PeerHooks<Saved> {
  dryRun: boolean
  manifest: string
  install: (changes: DependencyChange[]) => Promise<boolean>
  moved: (changes: DependencyChange[]) => void
  say: (verb: string, rest: string) => void
  snapshot: () => Promise<Saved & { source: string }>
  restore: (saved: Saved) => Promise<void>
  fail: (message: string) => void
}

// Adds the peers `had` to the app's devDependencies at the range `kay` (the one now installed) asks for, one it no longer lists left out; only says so on a dry run, and puts package.json and the lockfile back when the install fails. False when it did.
export async function addPeers<Saved>(kay: PeerManifest | undefined, had: string[], hooks: PeerHooks<Saved>): Promise<boolean> {
  const changes = had.flatMap((name) => {
    const spec = kay?.peerDependencies?.[name]

    return spec === undefined ? [] : [{ name, spec, section: 'devDependencies' }]
  })

  if (changes.length === 0)
    return true

  hooks.moved(changes)

  const list = changes.map(({ name, spec }) => `${name}@${spec}`).join(', ')
  const why = 'to devDependencies, which the app uses and kay no longer installs for it'

  if (hooks.dryRun) {
    hooks.say('would add', `${list} ${why}`)

    return true
  }

  const saved = await hooks.snapshot()

  await Bun.write(hooks.manifest, withDevDependencies(saved.source, changes))
  hooks.say('added', `${list} ${why}`)

  if (await hooks.install(changes))
    return true

  await hooks.restore(saved)
  hooks.fail(`the install of ${changes.map(({ name }) => name).join(', ')} failed, so package.json and the lockfile are back as they were; run \`bun add -d ${list}\``)

  return false
}

// `source` with `changes` added to its devDependencies, sorted as `bun add` leaves them, in the indent the file has.
export function withDevDependencies(source: string, changes: DependencyChange[]): string {
  const packageJson = JSON.parse(source) as Record<string, unknown>
  const dev = { ...(packageJson.devDependencies as Record<string, string> | undefined) }

  for (const { name, spec } of changes)
    dev[name] = spec

  packageJson.devDependencies = Object.fromEntries(Object.entries(dev).sort(([left], [right]) => left < right ? -1 : 1))

  return `${JSON.stringify(packageJson, null, INDENT.exec(source)?.[1] ?? '  ')}${source.endsWith('\n') ? '\n' : ''}`
}
