import { call } from 'kay'
import referrersApi from '../api/referrers'

// The entries naming each of `slugs` in a reference field, by slug, asked when a delete confirmation opens. A failed read tells none: the delete itself still goes through its own checks.
export async function readReferrers(collection: string, slugs: string[]): Promise<Record<string, string[]>> {
  if (slugs.length === 0)
    return {}

  try {
    return await call(referrersApi, '/:collection', { params: { collection }, query: { slugs: JSON.stringify(slugs) } })
  }
  catch {
    return {}
  }
}
