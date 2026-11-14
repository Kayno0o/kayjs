// What `kay add cms` writes: the extension with its defaults.
export default {
  description: 'collection screens under /admin, and content edited on the page it renders',
  extension: { import: 'import { cms } from \'@kayjs/cms\'', expression: 'cms()' },
  notes: ['Before production, set cms({ access }) and preview: {} in kay.config.ts, with KAY_SECRET set, and CMS_URL for the repository the edits are committed to (forgejo://TOKEN@git.example.com/owner/repo, github://TOKEN@owner/repo or gitlab://TOKEN@group/project), or cms({ files }): a production server refuses to boot with neither.'],
}
