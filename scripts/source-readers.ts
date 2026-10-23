// A change to a `.ts` or `.kay` file under `src/` or a library's `src/`.
export const SOURCE_CHANGE = /^(?:src|packages\/[^/]+\/src)\/.*\.(?:ts|kay)$/

// Tests scanning the kay and library sources as files, which an import graph does not show. Every one of them reads each source file, so they are the cost of a source change; `tests/land.test.ts` fails for a test scanning the sources that is not listed here.
export const SOURCE_READERS = [
  'tests/browsers.test.ts',
  'tests/docs.test.ts',
  'tests/errors.test.ts',
  'tests/kept-pages.test.ts',
  'tests/log-prefix.test.ts',
  'tests/markers.test.ts',
  'tests/packages.test.ts',
  'tests/pg-order.test.ts',
  'tests/privacy-storage.test.ts',
  'tests/side-effects.test.ts',
]

// What marks a test as scanning sources: a quoted glob of `src/` or `packages/<library>/src/`, or a scan of the `SRC` folder.
export const SOURCE_SCAN = /[`'"]\{?(?:src\/|packages\/[^`'"]*\/src\/)[^`'"]*\*[*.]|\.scan(?:Sync)?\(SRC\)/
