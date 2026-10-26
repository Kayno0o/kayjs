import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'

// Stable for a checkout and a name, so a session signed before a restart still reads (under `NODE_ENV=test` only while a seed file exists, else one of the process); a random seed kept in the git-ignored `.kay/` folder keeps the value from being computed by anyone who only knows the path.
export function devSecret(name: string): string {
  return new Bun.CryptoHasher('sha256').update(`kay dev secret\0${devSeed(name)}\0${process.cwd()}\0${name}`).digest('hex')
}

const SEED_LENGTH = 64
let seed: string | undefined

// Read once per process; a file that is missing, empty or cut short is written again.
function devSeed(name: string): string {
  if (seed !== undefined)
    return seed

  const folder = join(process.cwd(), '.kay')
  const file = join(folder, 'dev-secret')
  const read = (): string => {
    try {
      return readFileSync(file, 'utf8')
    }
    catch {
      return ''
    }
  }

  seed = read()

  if (seed.length >= SEED_LENGTH)
    return seed

  // A test run needs no file: a seed of this process serves, so a checkout whose `.kay` is read-only (a bind mount, a read-only checkout) tests as any other.
  if (process.env.NODE_ENV === 'test') {
    seed = crypto.randomUUID() + crypto.randomUUID()

    return seed
  }

  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(file, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 })
  }
  catch {
    seed = undefined

    throw new KayError('env-invalid', `kay: the development secret cannot be kept in ${folder}; make it writable, or set ${name}`)
  }

  seed = read()

  if (seed.length < SEED_LENGTH) {
    seed = undefined

    throw new KayError('env-invalid', `kay: the development secret in ${file} cannot be read back; make ${folder} writable, or set ${name}`)
  }

  return seed
}
