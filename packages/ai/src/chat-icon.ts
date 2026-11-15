import type { IconProps } from 'kay/icons'
import type { ChatIconValue } from './types'

// The icon an app gave for a button by name, else the library's own, typed as the `icon` of kayjs-ui's `Icon` takes it: the slot names it also takes are strings the settings map, which `IconProps` stands for here, as a `.ts` file cannot name that component's own type.
export function chatIcon<Name extends string>(icons: Partial<Record<Name, ChatIconValue>> | undefined, name: Name, fallback: string): IconProps {
  return (icons?.[name] ?? fallback) as IconProps
}
