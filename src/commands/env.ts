import type { EnvVariable } from '../server/env'
import type { EnvSchemaRecord } from '../server/env-state'
import type { Command } from './command'
import type { EnvFiles } from './env-compare'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { loadConfig } from '../config'
import { projectPaths } from '../project'
import { describeEnv } from '../server/env'
import { buildingWithoutEnv, listingEnv } from '../server/env-state'
import { registerLoader } from '../server/loader'
import { formatOption, printDocument, printedProblems, printFailure, printProblems, projectRoot, withStdoutOnStderr } from './command'
import { compareEnv, defaultEnvFiles, withDeclaredVariables } from './env-compare'
import { importApi } from './import-module'
import { USAGES } from './usages'

// A variable with the place that declares it.
export interface Listed extends EnvVariable {
  source: string
}

const DEFINE_ENV = /\bdefineEnv\s*\(/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

// What kay itself reads from the environment, apart from any schema.
const KAY_VARIABLES: EnvVariable[] = [
  { name: 'PORT', type: 'integer', required: false, default: 3000, description: 'the port the server listens on' },
  { name: 'HOST', type: 'string', required: false, description: 'the address the server listens on' },
  { name: 'SITE_URL', type: 'string (uri)', required: false, description: 'the origin the site is public at, unless `site` in kay.config.ts sets it' },
  { name: 'ORIGIN', type: 'string (uri)', required: false, description: 'deprecated, read until kay 1.73: the origin the site is public at when `SITE_URL` is unset; set `SITE_URL` instead, a value that is no http(s) origin being ignored' },
  { name: 'KAY_SECRET', type: 'string', required: false, description: 'at least 32 random characters, sealing sessions and signing form stamps, links to private files, the flash cookie and preview links, each under a key of its own; commas separate a rotation list, the first sealing, and only sessions and kayjs-auth opening the others; unless `secret` in kay.config.ts sets it' },
]

// What `proxy.key` reads: a production server with the setting refuses to boot without the key, given directly or as the file that holds it.
const PROXY_KEY_VARIABLES: EnvVariable[] = [
  { name: 'KAY_PROXY_KEY', type: 'string', required: 'production', secret: true, description: 'the key the proxy sends in the header `proxy.key` names, or set `KAY_PROXY_KEY_FILE` instead' },
  { name: 'KAY_PROXY_KEY_FILE', type: 'string', required: false, description: 'the path of a file holding the proxy key, read when `KAY_PROXY_KEY` is unset' },
]

// Every variable the project's `defineEnv` schemas, its `publicEnv` and its extensions declare, with whether each is required, in production only or always, and its default. The server entry is not run: the modules under `src` that call `defineEnv` are imported without the server's environment.
export const env: Command = {
  usage: USAGES.env,
  options: { format: { type: 'string' }, compose: { type: 'string', multiple: true }, example: { type: 'string' }, write: { type: 'boolean' } },
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
      const { variables, unread, findings } = await withStdoutOnStderr(async () => {
        const listed = await listEnv(root)
        const files = values.compose !== undefined || values.example !== undefined ? { compose: Array.isArray(values.compose) ? values.compose : undefined, example: typeof values.example === 'string' ? values.example : undefined } : await configuredEnvFiles(root)

        if (values.write === true) {
          const path = resolve(root, files?.example ?? '.env.example')
          const { text, added } = withDeclaredVariables(await Bun.file(path).exists() ? await readFile(path, 'utf8') : '', listed.variables)

          if (added.length > 0)
            await writeFile(path, text)

          console.error(added.length === 0 ? `${relative(root, path)} already lists every variable` : `${relative(root, path)}: added ${added.join(', ')}`)
        }

        return { ...listed, findings: files === undefined ? undefined : await compareEnv(root, listed.variables, files, listed.unread) }
      })

      if (format === 'json') {
        printDocument({ variables, unread, ...findings && { findings: await printedProblems(findings) } })

        return findings === undefined || !findings.some(({ severity }) => severity === 'error') ? 0 : 1
      }

      console.log(formatListing(variables) + (unread.length === 0 ? '' : `\n\n${unread.map(({ file, error }) => `Not read: ${file} (${error})`).join('\n')}`))

      if (findings === undefined)
        return 0

      return (await printProblems(findings, false, format)).failing > 0 ? 1 : 0
    }
    catch (error) {
      printFailure('env', error, format)

      return 1
    }
  },
}

// The files kay.config.ts names, else the project's own; none when `env` is `false`.
async function configuredEnvFiles(root: string): Promise<EnvFiles | undefined> {
  const { env } = await loadConfig(root)

  return env === false ? undefined : env ?? await defaultEnvFiles(root)
}

export async function listEnv(root: string): Promise<{ variables: Listed[], unread: { file: string, error: string }[] }> {
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

  // A library built at import time declares its own variables for the app, which says more than the extension's list, so the list adds only the rest.
  const declaredNames = new Set(declared.flatMap(({ schema }) => Object.keys(schema.properties)))
  const variables: Listed[] = [
    ...declared.flatMap(({ schema, file }) => described(schema, file === undefined ? 'src' : shown(file))),
    ...config.publicEnv ? described(config.publicEnv, 'publicEnv in kay.config.ts') : [],
    ...(config.extensions ?? []).flatMap(extension => extension.env === undefined ? [] : described(extension.env, `the extension ${extension.name}`).filter(({ name }) => !declaredNames.has(name))),
    ...KAY_VARIABLES.map(variable => ({ ...variable, source: 'kay' })),
    ...typeof config.proxy === 'object' && config.proxy.key !== undefined ? PROXY_KEY_VARIABLES.map(variable => ({ ...variable, source: 'kay' })) : [],
  ]

  return { variables, unread }
}

function described(schema: EnvSchemaRecord, source: string): Listed[] {
  return describeEnv(schema).map(variable => ({ ...variable, source }))
}

function formatListing(variables: Listed[]): string {
  const rows = variables.map(variable => [variable.name, variable.source, `${variable.type}${variable.secret === true ? ' (secret)' : ''}${variable.public === true ? ' (public)' : ''}`, variable.required === false ? 'optional' : variable.required, variable.default === undefined ? '' : JSON.stringify(variable.default), variable.description === undefined ? '' : `# ${variable.description}`])
  const widths = [0, 1, 2, 3, 4].map(column => Math.max(...rows.map(row => row[column]!.length)))

  return rows.map(row => row.map((cell, column) => column === 5 ? cell : cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n')
}
