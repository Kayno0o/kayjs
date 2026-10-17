import { dirname, join } from 'node:path'
import process from 'node:process'

// Looked up when asked, never on import: `kay build` and `kay start` never type-check, so a missing package must not stop them.
export function nativeManifest(): string {
  return Bun.resolveSync('typescript7/package.json', import.meta.dir)
}

// The package holding the native compiler's executable and the lib.d.ts files, beside the one `typescript7` names.
export function nativePlatformDir(): string {
  return dirname(Bun.resolveSync(`@typescript/typescript-${process.platform}-${process.arch}/package.json`, dirname(nativeManifest())))
}

export function nativeExe(): string {
  return join(nativePlatformDir(), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
}

// The manifest as a list, empty where the package is missing.
export function nativeManifestIfInstalled(): string[] {
  try {
    return [nativeManifest()]
  }
  catch {
    return []
  }
}
