import type { MissingPath } from '../server/not-found'
import type { Command } from './command'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { answeredBy, missingStore, NOT_FOUND_FILE } from '../server/not-found'
import { addRedirect, checkRedirect, redirectEntry } from '../server/not-found-config'
import { formatOption, printDocument, printFailure, projectRoot, shellQuote, withStdoutOnStderr } from './command'
import { USAGES } from './usages'

const REFERRER_LIMIT = 3

// The paths visitors asked for and found nothing at, most hit first, read from the file the production server keeps.
// `--redirect <path>` turns one into a redirect in kay.config.ts, to `--to` or to the suggested target; with `--runtime` it goes in the file instead, which the running site reads with no deploy, answering 307.
export const notFound: Command = {
  usage: USAGES['not-found'],
  options: { format: { type: 'string' }, redirect: { type: 'string' }, to: { type: 'string' }, file: { type: 'string' }, runtime: { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [path] }, refuse) => {
    const format = formatOption('not-found', values.format)

    if (format === undefined)
      return 1

    const root = projectRoot('not-found', path, format)

    if (root === undefined)
      return 1

    const redirect = typeof values.redirect === 'string' ? values.redirect : undefined
    const to = typeof values.to === 'string' ? values.to : undefined

    if (to !== undefined && redirect === undefined)
      return refuse('--to goes with --redirect')

    const runtime = values.runtime === true

    if (runtime && redirect === undefined)
      return refuse('--runtime goes with --redirect')

    const file = typeof values.file === 'string' ? values.file : join(root, NOT_FOUND_FILE)

    buildingWithoutEnv()

    try {
      const config = await withStdoutOnStderr(async () => loadConfig(root))
      const redirects = Object.keys(config.redirects ?? {})
      const redirected = new Set(redirects)
      const store = existsSync(file) || runtime ? missingStore(file, false) : undefined

      try {
        const all = store?.list() ?? []
        const answered = answeredBy(redirects)
        const missing = all.filter(row => !answered(row.path))

        if (redirect !== undefined) {
          const found = missing.find(row => row.path === redirect)
          const target = to ?? found?.target

          if (target === undefined)
            throw new Error(`${redirect} has no suggested target: name one with --to <path>`)

          if (runtime) {
            // Loaded here: the type checker's modules are heavy, and only this path needs them.
            const [{ configCheckOptions }, { servedPathsOf }] = await Promise.all([import('../check'), import('../check/shadow-types')])
            const options = configCheckOptions(config)
            const served = await servedPathsOf(root, options)
            const added = store!.redirects.add(redirect, target, undefined, { hosts: config.runtimeRedirects?.hosts ?? [], configured: Object.fromEntries(Object.entries(config.redirects ?? {}).map(([from, to]) => [from, typeof to === 'string' ? to : to.to])), served: () => served })

            store!.forget(added.from)

            if (format === 'json')
              printDocument({ redirect: { from: added.from, to: added.to, runtime: true } })
            else
              console.log(`Added to ${relative(process.cwd(), file) || file}, which the running site reads: ${added.from} -> ${added.to}`)

            return 0
          }

          checkRedirect(redirect, target, redirected)

          const written = await addRedirect(join(root, 'kay.config.ts'), redirect, target)

          if (written === 'by hand') {
            printFailure('not-found', `kay.config.ts has no \`redirects\` object literal to add the redirect to: add it by hand\n  ${redirectEntry(redirect, target)}`, format)

            return 1
          }

          store?.forget(redirect)

          if (format === 'json')
            printDocument({ redirect: { from: redirect, to: target } })
          else
            console.log(`Added to ${relative(process.cwd(), join(root, 'kay.config.ts')) || 'kay.config.ts'}: ${redirectEntry(redirect, target)}`)

          return 0
        }

        if (format === 'json') {
          printDocument({ missing })

          return 0
        }

        console.log(formatListing(missing, all.length > 0))

        return 0
      }
      finally {
        store?.close()
      }
    }
    catch (error) {
      printFailure('not-found', error instanceof Error ? error.message : error, format)

      return 1
    }
  },
}

function formatListing(missing: MissingPath[], redirected: boolean): string {
  if (missing.length === 0 && redirected)
    return 'Every recorded path has a redirect.'

  if (missing.length === 0)
    return 'No missing path recorded: the production server records the pages visitors asked for and found nothing at in data/not-found.sqlite.'

  return missing.map(({ path, hits, referrers, target, reason }) => {
    const from = referrers.slice(0, REFERRER_LIMIT).map(({ host }) => host).join(', ')
    const lines = [`${String(hits).padStart(6)}  ${path}${from === '' ? '' : `  (from ${from}${referrers.length > REFERRER_LIMIT ? ', ...' : ''})`}`]

    if (target !== undefined)
      lines.push(`        -> ${target}  (${reason}) kay not-found --redirect ${shellQuote(path)}`)

    return lines.join('\n')
  }).join('\n')
}
