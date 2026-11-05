import { existsSync } from 'node:fs'

const LIBRARY_FILE = /^packages\/(\w+)\//

// Where a library error's fix is written in the project asking: the library's folder in this repository, else the package installed in `node_modules`.
export function fixPath(file: string): string {
  const library = LIBRARY_FILE.exec(file)?.[1]

  return library === undefined || existsSync(file) ? file : file.replace(LIBRARY_FILE, `node_modules/@kaynooo/kayjs-${library}/`)
}
