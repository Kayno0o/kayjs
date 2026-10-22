import { realpathSync } from 'node:fs'

// The keys of `ctx` the templates a page reaches read, or every key when one of them uses `ctx` any other way.
export type ContextKeys = string[] | 'all'

// What the import graph says of each file, from the project's modules while building or from the build's record: the files it imports that the walk follows, and the keys of `ctx` its template reads, false when it reads none.
export interface ReachData {
  edges: (file: string) => string[]
  keys: (file: string) => ContextKeys | false
}

// What the import graph from some files leads to, read once for the scan of the routes.
export interface Reach {
  // Whether the files reach one of `targets`.
  reaches: (starts: string[], targets: string[]) => boolean
  // The keys of `ctx` the templates the files reach read, none when they reach no template reading `ctx`.
  contextKeys: (starts: string[]) => ContextKeys | undefined
}

function realFile(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// Walks `data` without a parser, so a server started from the build's record loads no compiler. The walk visits files in a fixed order, which the record keeps, so both read the same files.
export function reachOver(data: ReachData): Reach {
  const reached = new Map<string, boolean>()
  const context = new Map<string, ContextKeys | undefined>()
  const walk = (start: string, visit: (file: string) => boolean): void => {
    const seen = new Set<string>()
    const queue = [realFile(start)]

    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file))
        continue

      seen.add(file)

      if (visit(file))
        return

      queue.push(...data.edges(file))
    }
  }

  return {
    reaches(starts, targets) {
      const wanted = new Set(targets.map(realFile))
      const key = [...wanted].join('\0')

      return starts.some((start) => {
        const at = `${key}\0${start}`
        let found = reached.get(at)

        if (found === undefined) {
          found = false
          walk(start, (file) => {
            found = wanted.has(file)

            return found
          })
          reached.set(at, found)
        }

        return found
      })
    },
    contextKeys(starts) {
      const found = new Set<string>()
      let reading = false

      for (const start of starts) {
        if (!context.has(start)) {
          const here = new Set<string>()
          let read = false
          let whole = false

          // The whole closure is read whatever it finds, as the build records the files a walk met and an early end would depend on their order.
          walk(start, (file) => {
            const keys = data.keys(file)

            if (keys !== false) {
              read = true

              if (keys === 'all') {
                whole = true
              }
              else {
                for (const key of keys) {
                  here.add(key)
                }
              }
            }

            return false
          })

          if (read)
            context.set(start, whole ? 'all' : [...here])
          else
            context.set(start, undefined)
        }

        const own = context.get(start)

        if (own === 'all')
          return 'all'

        if (own !== undefined) {
          reading = true
          for (const key of own) {
            found.add(key)
          }
        }
      }

      return reading ? [...found] : undefined
    },
  }
}
