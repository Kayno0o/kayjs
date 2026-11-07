import type { IconProps } from 'kay/icons'
import type { OptionsQuery } from './options-source'

// One icon a picker's search found: `name` is what the picker submits and hands over, `icon` what it draws.
export interface IconChoice {
  name: string
  icon: IconProps
}

// The readable part of an icon name, without a set prefix such as `tabler:`.
export function nameOf(icon: string): string {
  return icon.slice(icon.indexOf(':') + 1)
}

// What a function `icons` is asked: the text typed, and the page wanted, `limit` icons from the `offset`th on.
export interface IconQuery extends OptionsQuery {
  limit: number
  offset: number
}
