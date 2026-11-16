import type { AwaitAlert } from '../compiler/names'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { messageKeys } from '../compiler/island-arguments'

export const AWAIT_ALERT_FILE = 'src/await-failed.kay'

const read = new Map<string, { stamp: string, alert: AwaitAlert }>()

// Whether a compiled file is the alert itself, by path or through a symlink; a name that is not on disk (an in-memory twin) is not it.
function isAlert(compiling: string, file: string): boolean {
  return resolve(compiling) === file || (existsSync(compiling) && realpathSync(compiling) === realpathSync(file))
}

// The app's component for an `await` with no `catch` and no `try` around it, found by name in `src/`, with the message keys it words; none when the app has no such file, which leaves kay's alert, nor for the file itself, whose own `await` would import it.
export function awaitAlertOf(root: string, compiling?: string): AwaitAlert | undefined {
  const file = join(resolve(root), AWAIT_ALERT_FILE)

  if (!existsSync(file) || (compiling !== undefined && isAlert(compiling, file)))
    return undefined

  const { size, lastModified } = Bun.file(file)
  const stamp = `${size}:${lastModified}`
  const kept = read.get(file)

  if (kept?.stamp === stamp)
    return kept.alert

  const alert = { file, keys: messageKeys(readFileSync(file, 'utf8')) }

  read.set(file, { stamp, alert })

  return alert
}
