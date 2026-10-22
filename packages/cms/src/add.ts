// What `kay add cms` writes: the extension with its defaults.
export default {
  description: 'collection screens under /admin, and content edited on the page it renders',
  extension: { import: 'import { cms } from \'@kaynooo/kayjs-cms\'', expression: 'cms()' },
  notes: ['Before production, set cms({ role }) or cms({ guard }) and preview: {} in kay.config.ts, with KAY_SECRET set, and CMS_BASE_URL, CMS_REPO and CMS_TOKEN for the Forgejo edits are committed to, or cms({ files }): a production server refuses to boot with neither.'],
}
