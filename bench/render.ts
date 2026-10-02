import { appFromArgs, loadApp } from './apps'

// Prints the HTML an app serves for a path: `bun bench/render.ts solid /table`.
const app = await loadApp(appFromArgs())
const response = await app.handle(new Request(`http://localhost${Bun.argv[3] ?? '/'}`))

process.stdout.write(await response.text())
