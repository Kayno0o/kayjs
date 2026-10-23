// The `ui.*` and `cms.*` message keys that ended in `Label` before 1.72, whose accessible-name texts took the plain name; these ones collided with a visible text of the same name and were renamed to what the table says.
const RENAMED: Record<string, string> = {
  'ui.markdownEditor.previewLabel': 'ui.markdownEditor.preview',
  'cms.history.restoreLabel': 'cms.history.restoreButton',
  'cms.admin.searchLabel': 'cms.admin.searchAria',
  'cms.blocks.addFirstLabel': 'cms.blocks.addFirstAria',
  'cms.list.jumpLabel': 'cms.list.jumpAria',
  'cms.media.renameLabel': 'cms.media.renameAria',
  'cms.missing.addLabel': 'cms.missing.addAria',
  'cms.missing.copyLabel': 'cms.missing.copyAria',
  'cms.missing.dismissLabel': 'cms.missing.dismissAria',
  'cms.missing.goneLabel': 'cms.missing.goneAria',
  'cms.missing.permanentLabel': 'cms.missing.permanentAria',
  'cms.redirects.removeLabel': 'cms.redirects.removeAria',
  'cms.redirects.saveLabel': 'cms.redirects.saveAria',
  'cms.table.moveDownLabel': 'cms.table.moveDownAria',
  'cms.table.moveUpLabel': 'cms.table.moveUpAria',
  'cms.table.duplicateLabel': 'cms.table.duplicateAria',
}
const LABELLED = /^(?:ui|cms)\.[\w.]*[a-z]Label$/

// The key a library's text is looked up under now, for a `ui.*` or `cms.*` key that ended in `Label` before 1.72; undefined for any other key.
export function renamedMessageKey(key: string): string | undefined {
  return RENAMED[key] ?? (LABELLED.test(key) ? key.slice(0, -'Label'.length) : undefined)
}
