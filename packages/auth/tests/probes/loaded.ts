// Registers and reads the user on an app with no passkey and no OAuth, then prints the node_modules packages that were loaded.
import { testApp } from '../helpers/app'

const { browser } = testApp()
const visitor = browser()

await visitor.call('register', { email: 'ada@example.com', password: 'correct horse battery' })
await visitor.json('/me')

const packages = new Set(Object.keys(require.cache).map(path => (/node_modules\/((?:@[^/]+\/)?[^/]+)/).exec(path)?.[1]).filter(Boolean))

console.log(JSON.stringify([...packages]))
