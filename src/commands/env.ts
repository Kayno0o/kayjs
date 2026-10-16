import type { EnvVariable } from '../server/env'
import type { EnvSchemaRecord } from '../server/env-state'
import type { Command } from './command'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { loadConfig } from '../config'
import { projectPaths } from '../project'
import { describeEnv } from '../server/env'
import { buildingWithoutEnv, listingEnv } from '../server/env-state'
import { registerLoader } from '../server/loader'
import { formatOption, printDocument, printFailure, projectRoot, withStdoutOnStderr } from './command'
import { importApi } from './import-module'
import { USAGES } from './usages'

// A variable with the place that declares it.
interface Listed extends EnvVariable {
  source: string
}

const DEFINE_ENV = /\bdefineEnv\s*\(/
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

// What kay itself reads from the environment, apart from any schema.
const KAY_VARIABLES: EnvVariable[] = [
  { name: 'PORT', type: 'integer', required: false, default: 3000, description: 'the port the server listens on' },
  { name: 'HOST', type: 'string', required: false, description: 'the address the server listens on' },
  { name: 'SITE_URL', type: 'string (uri)', required: false, description: 'the origin the site is public at, unless `site` in kay.config.ts sets it' },
]

// Every variable the project's `defineEnv` schemas, its `publicEnv` and its extensions declare, with whether each is required, in production only or always, and its default. The server entry is not run: the modules under `src` that call `defineEnv` are imported without the server's environment.
export const env: Command = {
  usage: USAGES.env,
  options: { format: { type: 'string' } },
  positionals: 1,
  run: async ({ values, positionals: [path] }) => {
    const format = formatOption('env', values.format)

    if (format === undefined)
      return 1

    const root = projectRoot('env', path, format)

    if (root === undefined)
      return 1

    buildingWithoutEnv()

    try {
      const { variables, unread } = await withStdoutOnStderr(async () => listEnv(root))

      if (format === 'json') {
        printDocument({ variables, unread })

        return 0
      }

      console.log(formatListing(variables) + (unread.length === 0 ? '' : `\n\n${unread.map(({ file, error }) => `Not read: ${file} (${error})`).join('\n')}`))

      return 0
    }
    catch (error) {
      printFailure('env', error, format)

      return 1
    }
  },
}

async function listEnv(root: string): Promise<{ variables: Listed[], unread: { file: string, error: string }[] }> {
  const config = await loadConfig(root)
  const declared = listingEnv()
  const shown = (file: string) => relative(root, file)
  const unread: { file: string, error: string }[] = []
  // The server entry listens as it is imported, so its own schema is left out.
  const entry = relative(root, projectPaths(root, config).entry)
  const files = [...new Bun.Glob('src/**/*.{ts,kay}').scanSync({ cwd: root })].sort().filter(file => !TEST_FILE.test(file) && file !== entry)

  await registerLoader(root, config.settings ?? {})

  for (const file of files) {
    if (!DEFINE_ENV.test(await readFile(join(root, file), 'utf8')))
      continue

    try {
      await importApi(resolve(root, file))
    }
    catch (error) {
      unread.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const variables: Listed[] = [
    ...declared.flatMap(({ schema, file }) => described(schema, file === undefined ? 'src' : shown(file))),
    ...config.publicEnv ? described(config.publicEnv, 'publicEnv in kay.config.ts') : [],
    ...(config.extensions ?? []).flatMap(extension => extension.env === undefined ? [] : described(extension.env, `the extension ${extension.name}`)),
    ...KAY_VARIABLES.map(variable => ({ ...variable, source: 'kay' })),
  ]

  return { variables, unread }
}

function described(schema: EnvSchemaRecord, source: string): Listed[] {
  return describeEnv(schema).map(variable => ({ ...variable, source }))
}

function formatListing(variables: Listed[]): string {
  const rows = variables.map(variable => [variable.name, variable.source, variable.type, variable.required === false ? 'optional' : variable.required, variable.default === undefined ? '' : JSON.stringify(variable.default), variable.description === undefined ? '' : `# ${variable.description}`])
  const widths = [0, 1, 2, 3, 4].map(column => Math.max(...rows.map(row => row[column]!.length)))

  return rows.map(row => row.map((cell, column) => column === 5 ? cell : cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n')
}
