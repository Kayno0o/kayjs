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
