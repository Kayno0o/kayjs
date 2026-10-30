import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const KEY_FILE = '.kay/lint-cache-key'

// ESLint keys its cache on a file's content and the lint config, not on the tsconfig or the shadow types a type-aware rule reads, so a result from before they changed (a parsing error above all) would outlive its cause.
// Returns whether the cache file was dropped. The key is the tsconfig and every file under `.kay/types`, kept beside them.
export async function dropStaleLintCache(root: string, args: readonly string[], cwd = process.cwd()): Promise<boolean> {
  const hasher = new Bun.CryptoHasher('sha256')

  hasher.update(await readIfAny(join(root, 'tsconfig.json')))

  const types = join(root, '.kay/types')

  if (existsSync(types)) {
    for (const file of [...new Bun.Glob('**/*').scanSync({ cwd: types, onlyFiles: true })].toSorted()) {
      hasher.update(file)
      hasher.update(await Bun.file(join(types, file)).bytes())
    }
  }

  const key = hasher.digest('hex')
  const keyFile = join(root, KEY_FILE)

  if (await readIfAny(keyFile) === key)
    return false

  await mkdir(dirname(keyFile), { recursive: true })
  await Bun.write(keyFile, key)

  // A cache location that is a folder holds one file per project, named by ESLint: left alone.
  const location = cacheLocation(args, cwd)

  if (location.endsWith('/'))
    return false

  await rm(location, { force: true })

  return true
}

async function readIfAny(file: string): Promise<string> {
  return existsSync(file) ? Bun.file(file).text() : ''
}

function cacheLocation(args: readonly string[], cwd: string): string {
  for (const [index, arg] of args.entries()) {
    let value: string | undefined

    if (arg === '--cache-location')
      value = args[index + 1]
    else if (arg.startsWith('--cache-location='))
      value = arg.slice('--cache-location='.length)

    if (value !== undefined)
      return value.endsWith('/') ? value : resolve(cwd, value)
  }

  return join(cwd, '.eslintcache')
}
