export const APPS = ['kay', 'solid', 'svelte'] as const

export type AppName = typeof APPS[number]

export interface BenchApp {
  handle: (request: Request) => Promise<Response>
}

export function isApp(name: string | undefined): name is AppName {
  return APPS.includes(name as AppName)
}

// Each app lives in its own package, so it is loaded in its own process, with its own dependencies.
export async function loadApp(name: AppName): Promise<BenchApp> {
  const { createApp } = await import(`./apps/${name}/app.ts`) as { createApp: () => Promise<BenchApp> }

  return createApp()
}

export function appFromArgs(): AppName {
  const name = Bun.argv[2]

  if (!isApp(name))
    throw new Error(`Expected an app name: ${APPS.join(', ')}`)

  return name
}
