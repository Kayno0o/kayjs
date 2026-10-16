import process from 'node:process'
import { importModule } from '../server/bundle'
import { withStdoutOnStderr } from './command'

// An API module runs as it is imported: what it writes to stdout goes to stderr, off the listing, and its `process.exit()` fails it alone.
export async function importApi(file: string): Promise<{ default?: unknown }> {
  const exit: unknown = Reflect.get(process, 'exit')

  process.exit = (code?: number) => {
    throw new Error(`it calls process.exit(${code ?? ''})`)
  }

  try {
    return await withStdoutOnStderr(async () => importModule<{ default?: unknown }>(file))
  }
  finally {
    Reflect.set(process, 'exit', exit)
  }
}
