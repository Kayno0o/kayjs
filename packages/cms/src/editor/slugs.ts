import { call } from 'kay'
import slugsApi from '../api/slugs'
import { checkSlug } from '../slug'

export interface HeldSlug {
  slug: string
  locale?: string | undefined
}

// The slugs a collection holds, with their locale; undefined when they cannot be read, as they only flag a taken one and a folder typo and the server decides.
export async function readHeldSlugs(collection: string): Promise<HeldSlug[] | undefined> {
  try {
    const slugs = await call(slugsApi, '/:collection', { params: { collection } })

    return Array.isArray(slugs) ? slugs : undefined
  }
  catch {
    return undefined
  }
}

// Where a slug lands among those held in one locale.
export function reportSlug(slug: string, held: readonly HeldSlug[], locale: string | undefined): ReturnType<typeof checkSlug> {
  return checkSlug(slug, held.filter(entry => entry.locale === locale).map(entry => entry.slug))
}
