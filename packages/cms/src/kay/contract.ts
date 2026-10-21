// The shapes kayjs-cms passes around: kay's own from kay/content, and the entry references and issues its forms and API share.
import type { CollectionInfo, SourceEntry } from 'kay/content'
import type { IconProps } from 'kay/icons'

export type { CollectionInfo, DataValue, EntryFile, EntryFilter, FieldHint, FieldInputOptions, JsonSchema, SourceEntry, TranslationIndex } from 'kay/content'

// The buttons of a Markdown box's toolbar, as kayjs-ui's MarkdownEditor names them; declared here so the config types do not import its components (tests/layout.test.ts holds the two lists equal).
export type ToolbarAction = 'bold' | 'italic' | 'heading' | 'bulletList' | 'numberedList' | 'link' | 'image'

// How a collection's form is arranged: `fields` first, in that order, an inner array being one row of columns, then the others in the schema's order unless hidden; the Markdown body is `body`, or `#body` when a data field has that name.
export interface FormLayout {
  fields?: (string | string[])[] | undefined
  hide?: string[] | undefined
  // The words over the Markdown body: its label (`Body` by default, translated) and a hint under it.
  body?: { label?: string | undefined, hint?: string | undefined } | undefined
  // The formatting buttons over every Markdown box of the collection, the body included: `false` for none, else the buttons to keep, in order; all by default.
  toolbar?: boolean | ToolbarAction[] | undefined
  // The classes the preview of every Markdown box of the collection puts on its HTML, so it takes the styles the site's pages give rendered Markdown, such as `prose`.
  previewClass?: string | undefined
}

// What a row of a collection's list can offer beside its title.
export type RowAction = 'move' | 'publish' | 'unpublish' | 'duplicate' | 'rename' | 'editOnPage' | 'delete'

// The columns of a collection's list, field keys shown after the title, and the row actions kept, all by default.
export interface ListLayout {
  columns?: string[] | undefined
  actions?: RowAction[] | undefined
}

export interface CollectionLayout {
  // The heading the content list puts the collection under; collections with none come first.
  group?: string | undefined
  // Where the collection stands in the content list, among its group: the lowest first, then the site's order.
  order?: number | undefined
  form?: FormLayout | undefined
  list?: ListLayout | undefined
}

// What `cms({ collections })` gave a collection: its layout and the icon the content list draws before it, which stays on the server, as the editor's islands would otherwise carry it with each page.
export type GivenLayout = CollectionLayout & { icon?: IconProps | undefined }

// A collection as the screens read it: kay's, with the layout `cms({ collections })` gave it.
// `history` is set for a collection that keeps its entries' revisions, and `trash` for one that keeps its deleted entries, which the screens then link to.
export type ScreenCollection = CollectionInfo & { layout?: CollectionLayout | undefined, history?: true | undefined, trash?: true | undefined }

export interface EntryRef {
  collection: string
  slug: string
  locale?: string | undefined
}

export interface Issue extends EntryRef {
  // Dotted, relative to the data; `''` for the entry as a whole, or its body when `body` is set.
  path: string
  body?: true | undefined
  // Set with `path: ''` when the slug or the locale itself is refused.
  key?: 'slug' | 'locale' | undefined
  message: string
}

export interface DraftEntry extends EntryRef {
  data: Record<string, unknown>
  body?: string | undefined
}

// An entry as the editor opens it: `version` is its file's, which a save names so one made over someone else's is refused.
export interface StoredEntry extends SourceEntry {
  version?: string | undefined
}

export interface DraftResult {
  issues?: Issue[] | undefined
}

// What the editor gives the component of a field kind an app adds, `src/cms/fields/<kind>.kay`: `const { value, onChange, label } = props<CustomFieldProps>()`.
export interface CustomFieldProps {
  // What the entry holds in this field now, `undefined` for a new one.
  value: unknown
  // Sets the field's value; the schema validates it when the entry is saved.
  onChange: (next: unknown) => void
  label: string
  hint?: string | undefined
  // Why the last save refused this field's value.
  issue?: string | undefined
  required: boolean
}
