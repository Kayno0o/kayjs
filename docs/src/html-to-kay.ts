// The translation of `kay fmt --from-html`, imported when the converter asks for it, so it is a chunk only that box fetches. A `.kay` file cannot import it by a relative path out of the docs, as its checked copy lives elsewhere.
export async function loadConverter(): Promise<typeof import('../../src/migrate/html')> {
  return import('../../src/migrate/html')
}
