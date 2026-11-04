import type { KayConfig } from '../config'
import { projectPaths } from '../project'
import { routeMounts } from '../server/routes'

// The directories holding the project's pages: its routes directory and the ones its extensions mount, not the folder of an outer layout, whose other `.kay` files are components.
export function pageDirs(root: string, config: KayConfig): string[] {
  return [projectPaths(root, config).routes, ...routeMounts(root, config.extensions, false).filter(mount => mount.outer === undefined).map(mount => mount.dir)]
}
