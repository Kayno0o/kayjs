// What kay's `~icons/<prefix>/<name>` imports give, which an app's `kay check` declares icon by icon; kayjs-ui's root, which the bell test imports, takes any name here.
declare module '~icons/*' {
  import type { IconProps } from 'kay/icons'

  const icon: IconProps

  export default icon
}
