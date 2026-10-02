// The babel presets ship no types; both are plain preset objects to babel.
declare module 'babel-preset-solid' {
  import type { PluginItem } from '@babel/core'

  const preset: PluginItem

  export default preset
}

declare module '@babel/preset-typescript' {
  import type { PluginItem } from '@babel/core'

  const preset: PluginItem

  export default preset
}
