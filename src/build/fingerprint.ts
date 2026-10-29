import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nativeManifestIfInstalled } from '../compiler/native-typescript'

// The packages a compile runs through, their versions part of every cache key.
const COMPILER_PACKAGES = ['@babel/parser/package.json', '@babel/types/package.json']
const fingerprints = new Map<string, string>()
const SCRIPT_FILE = /\.tsx?$/

export function compilerFingerprint(bunVersion = Bun.version): string {
  let fingerprint = fingerprints.get(bunVersion)

  if (fingerprint === undefined) {
    const hasher = new Bun.CryptoHasher('sha256')

    // What a compile depends on besides its source: kay's compiler with every module it imports, kay's own version, the packages it runs through, tsgo's among them for the browser globals it declares, and Bun's version, as a markdown block is lowered with `Bun.markdown`.
    const compilerDir = join(import.meta.dir, '../compiler')
    const sources = [
      ...compilerModules(compilerDir),
      import.meta.path,
      join(import.meta.dir, 'transform.ts'),
      join(import.meta.dir, 'probe.ts'),
      join(import.meta.dir, '../check/shadow.ts'),
      join(import.meta.dir, '../../package.json'),
      ...COMPILER_PACKAGES.map(manifest => Bun.resolveSync(manifest, compilerDir)),
      ...nativeManifestIfInstalled(),
    ]

    for (const file of sources)
      hasher.update(readFileSync(file))

    hasher.update(`\0bun ${bunVersion}`)
    fingerprint = hasher.digest('hex')
    fingerprints.set(bunVersion, fingerprint)
  }

  return fingerprint
}

// Every file of the compiler and the kay modules it imports, followed through their own relative imports, sorted.
export function compilerModules(compilerDir: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const found = new Set(readdirSync(compilerDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)))

  for (const file of found) {
    if (!SCRIPT_FILE.test(file))
      continue

    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (path.startsWith('.'))
        found.add(Bun.resolveSync(path, dirname(file)))
    }
  }

  return [...found].sort()
}
