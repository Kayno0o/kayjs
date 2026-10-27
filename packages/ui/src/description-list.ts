export interface DescriptionItem {
  // Tells items apart, the label by default.
  key?: string | undefined
  label: string
  // Shown as text; an item without one is drawn by the `@value` block.
  value?: string | number | undefined
}
