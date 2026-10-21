import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'

// Stable for a checkout and a name, so a session signed before a restart still reads; a random seed kept in the git-ignored `.kay/` folder keeps the value from being computed by anyone who only knows the path.
export function devSecret(name: string): string {
  return new Bun.CryptoHasher('sha256').update(`kay dev secret\0${devSeed()}\0${process.cwd()}\0${name}`).digest('hex')
}

const SEED_LENGTH = 64
let seed: string | undefined

// Read once per process; a file that is missing, empty or cut short is written again.
function devSeed(): string {
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

  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(file, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 })
  }
  catch {
    seed = undefined

    throw new KayError('env-invalid', `kay: the development secret cannot be kept in ${folder}; make it writable, or set the secret's variable`)
  }

  seed = read()

  if (seed.length < SEED_LENGTH) {
    seed = undefined

    throw new KayError('env-invalid', `kay: the development secret in ${file} cannot be read back; make ${folder} writable, or set the secret's variable`)
  }

  return seed
}
