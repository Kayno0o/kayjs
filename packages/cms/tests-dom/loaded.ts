import { until } from '../tests/until'

// Waits for the entry form an editor opens on its own to be drawn, which it reads first.
export async function entryLoaded(root: ParentNode): Promise<void> {
  await until(() => root.querySelector('.kcms-entry') !== null && root.querySelector('.kcms-entry-loading') === null)
}
