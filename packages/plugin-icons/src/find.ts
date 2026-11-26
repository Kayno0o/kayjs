// `kay icons-find <words> [--set <prefix>] [--limit <n>]`: prints the `~icons/<set>/<name>` imports matching the words, so an agent imports icons that exist.

import type { IconLookup } from './diagnose'

const FOUND_PER_SET = 10
const USAGE = 'Usage: kay icons-find <words> [--set <prefix>] [--limit <n>]'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export async function iconsFind(args: string[], lookup: IconLookup): Promise<void> {
  const words: string[] = []
  let only: string | undefined
  let limit = FOUND_PER_SET
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--set' || arg === '--limit') {
      const value = args[++i] ?? fail(USAGE)
      if (arg === '--set')
        only = value
      else
        limit = Number(value)
    }
    else {
      words.push(arg)
    }
  }
  const query = words.join(' ')
  if (query.trim() === '' || !Number.isInteger(limit) || limit < 1)
    fail(USAGE)

  const installed = lookup.prefixes().sort()
  if (installed.length === 0)
    fail('No icon set installed. Install one, such as @iconify-json/tabler.')
  if (only !== undefined && !installed.includes(only))
    fail(`No icon set "${only}" is installed. Installed: ${installed.join(', ')}.`)

  const prefixes = only === undefined ? installed : [only]
  // Imported here so the word table never reaches a bundle that only draws icons.
  const [{ findIcons }, sets] = await Promise.all([import('./search'), Promise.all(prefixes.map(prefix => lookup.set(prefix)))])
  for (const [i, prefix] of prefixes.entries()) {
    for (const name of findIcons(sets[i]!, query, { limit }))
      console.log(`~icons/${prefix}/${name}`)
  }
}
