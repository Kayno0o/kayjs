// What kay's `~icons/<prefix>/<name>` imports give, which an app's `kay check` declares icon by icon; the library's own check takes any name.
declare module '~icons/*' {
  import type { IconProps } from 'kay/icons'

  const icon: IconProps

  export default icon
}
