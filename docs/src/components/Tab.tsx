import type { KayChild } from 'kay'

export function Tab({ group, label, checked, children }: {
  group: string
  label: string
  checked?: boolean | undefined
  children?: KayChild
}) {
  const id = `tab-${group}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <>
      <input class="md-tab-input" type="radio" name={group} id={id} checked={checked} />
      <label class="md-tab-label" for={id}>{label}</label>
      <div class="md-tab-panel">{children}</div>
    </>
  )
}
