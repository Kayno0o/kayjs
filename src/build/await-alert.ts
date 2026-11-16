import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The app's component for an `await` with no `catch` and no `try` around it, found by name in `src/`; none when the app has no such file, which leaves kay's alert, nor for the file itself, whose own `await` would import it.
export function awaitAlertOf(root: string, compiling?: string): string | undefined {
  const file = join(resolve(root), 'src', 'await-failed.kay')

  return file !== compiling && existsSync(file) ? file : undefined
}
