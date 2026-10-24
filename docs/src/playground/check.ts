import { compileKay } from '../../../src/compiler'
import { isRunnable } from './runnable'

// Whether the playground offers a docs example: the static rule of `isRunnable` and a server compile with no error. Nothing is executed, as highlighting also reaches code a visitor made the chat write.
export function runs(source: string): boolean {
  if (!isRunnable(source))
    return false

  try {
    return !compileKay(source, '/playground.kay', { root: '/', output: 'html' }).diagnostics.some(diagnostic => !diagnostic.checkOnly)
  }
  catch {
    return false
  }
}
