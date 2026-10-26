import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'

// Stable for a checkout and a name, so a session signed before a restart still reads (in `test` mode only while a seed file exists, else one of the process, which its subprocesses inherit through `KAY_DEV_SEED`); a random seed kept in the git-ignored `.kay/` folder keeps the value from being computed by anyone who only knows the path.
export function devSecret(name: string, mode: string | undefined): string {
  return new Bun.CryptoHasher('sha256').update(`kay dev secret\0${devSeed(name, mode)}\0${process.cwd()}\0${name}`).digest('hex')
}

const SEED_LENGTH = 64
const SEED_VARIABLE = 'KAY_DEV_SEED'
let seed: string | undefined

// Read once per process; a file that is missing, empty or cut short is written again.
function devSeed(name: string, mode: string | undefined): string {
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

  // A test run needs no file: a seed of this process serves, so a checkout whose `.kay` is read-only (a bind mount, a read-only checkout) tests as any other. It goes into the environment, so a subprocess the test spawns derives the same secret and reads the cookies of its parent.
  if (mode === 'test') {
    const inherited = process.env[SEED_VARIABLE] ?? ''

    seed = inherited.length >= SEED_LENGTH ? inherited : crypto.randomUUID() + crypto.randomUUID()
    process.env[SEED_VARIABLE] = seed

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
