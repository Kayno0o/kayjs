import type { IconProps } from 'kay/icons'

// One icon a picker's search found: `name` is what the picker submits and hands over, `icon` what it draws.
export interface IconChoice {
  name: string
  icon: IconProps
}

// The readable part of an icon name, without a set prefix such as `tabler:`.
export function nameOf(icon: string): string {
  return icon.slice(icon.indexOf(':') + 1)
}
