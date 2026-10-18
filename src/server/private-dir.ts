import { chmod, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

const OTHERS = 0o077
const PRIVATE_DIR = 0o700

export const PRIVATE_FILE = 0o600

// This process's user, or undefined where the platform has none (the ownership checks are then skipped).
const uid = process.getuid?.()

// Whether a file or folder on disk is this user's own, not a link and closed to every other user.
export async function isPrivate(path: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const found = await lstat(path)

    return (kind === 'file' ? found.isFile() : found.isDirectory()) && (uid === undefined || found.uid === uid) && (found.mode & OTHERS) === 0
  }
  catch {
    return false
  }
}

// A folder only this user can enter, `path` itself when it is or can be made one, else a fresh random one in the temp folder: a link, or a folder another user made first, is never written into.
export async function privateDir(path: string): Promise<string> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await mkdir(path, { mode: PRIVATE_DIR })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      return mkdtemp(join(tmpdir(), 'kay-private-'))
  }

  try {
    const found = await lstat(path)

    if (found.isDirectory() && (uid === undefined || found.uid === uid)) {
      // A folder an older kay made, or a umask let through, is closed.
      if ((found.mode & OTHERS) !== 0)
        await chmod(path, PRIVATE_DIR)

      return path
    }
  }
  catch {}

  return mkdtemp(join(tmpdir(), 'kay-private-'))
}

// Writes a file only this user can read: it exists at that mode before any byte goes in, as Bun.write ignores a mode.
export async function writePrivate(path: string, data: Blob | Uint8Array | string): Promise<void> {
  await writeFile(path, '', { mode: PRIVATE_FILE })
  await chmod(path, PRIVATE_FILE)
  await Bun.write(path, data)
}
