import { dirname, join } from 'node:path'
import process from 'node:process'
import { MissingPeerError, peerInstalled, platformMissingMessage, resolvePeer } from '../peers'

// Looked up when asked, never on import: `kay build` and `kay start` never type-check, so a missing package must not stop them.
export function nativeManifest(from?: string): string {
  return resolvePeer('typescript7', 'typescript7/package.json', from)
}

// The package holding the native compiler's executable and the lib.d.ts files, beside the one `typescript7` names.
export function nativePlatformDir(from?: string): string {
  const manifest = nativeManifest(from)

  try {
    return dirname(Bun.resolveSync(`@typescript/typescript-${process.platform}-${process.arch}/package.json`, dirname(manifest)))
  }
  catch (error) {
    throw new MissingPeerError(platformMissingMessage(), { cause: error })
  }
}

export function nativeExe(from?: string): string {
  return join(nativePlatformDir(from), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
}

// The manifest as a list, empty where the package is missing.
export function nativeManifestIfInstalled(): string[] {
  return peerInstalled('typescript7') ? [nativeManifest()] : []
}
