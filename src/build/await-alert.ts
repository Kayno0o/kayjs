import type { AwaitAlert } from '../compiler/names'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { messageKeys } from '../compiler/island-arguments'

export const AWAIT_ALERT_FILE = 'src/await-failed.kay'

const read = new Map<string, { stamp: number, alert: AwaitAlert }>()

// The app's component for an `await` with no `catch` and no `try` around it, found by name in `src/`, with the message keys it words; none when the app has no such file, which leaves kay's alert, nor for the file itself, whose own `await` would import it.
export function awaitAlertOf(root: string, compiling?: string): AwaitAlert | undefined {
  const file = join(resolve(root), AWAIT_ALERT_FILE)

  if (!existsSync(file) || (compiling !== undefined && realpathSync(compiling) === realpathSync(file)))
    return undefined

  const stamp = Bun.file(file).lastModified
  const kept = read.get(file)

  if (kept?.stamp === stamp)
    return kept.alert

  const alert = { file, keys: messageKeys(readFileSync(file, 'utf8')) }

  read.set(file, { stamp, alert })

  return alert
}
