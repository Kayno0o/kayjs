// Stands in for a headless CMS: entries a test edits, and what each load asked for.
export interface CmsEntry {
  slug: string
  title: string
  published: boolean
  body: string
}

export const cms = {
  entries: [] as CmsEntry[],
  loads: [] as boolean[],
}

export function resetCms(): void {
  cms.entries = [
    { slug: 'launch', title: 'Launch day', published: true, body: '## What ships\n\nEverything.' },
    { slug: 'roadmap', title: 'Next year', published: false, body: 'Not yet.' },
  ]
  cms.loads = []
}

resetCms()

// What a CMS's API would do with an entry an editor saved or deleted.
export function saveToCms(entry: { slug: string, data: unknown, body?: string | undefined }): void {
  const { title, published } = entry.data as { title: string, published: boolean }

  cms.entries = [...cms.entries.filter(each => each.slug !== entry.slug), { slug: entry.slug, title, published, body: entry.body ?? '' }]
}

export function removeFromCms(entry: { slug: string }): void {
  cms.entries = cms.entries.filter(each => each.slug !== entry.slug)
}
