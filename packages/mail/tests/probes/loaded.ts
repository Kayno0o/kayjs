// Makes a mailer as `mode` says and sends one mail, then prints the node_modules packages that were loaded.
import process from 'node:process'
import { mailer } from '../../src/mailer'
import { startSmtp } from '../helpers/smtp'

const PACKAGE_PATH = /(?:node_modules|packages\/mail)\/(.+)/

const mode = process.argv[2]
const server = mode === 'smtp' ? startSmtp() : undefined

if (mode === 'dev') {
  process.env.NODE_ENV = 'development'
  process.env.KAY_DEV_CODE = '0'
}

if (server) {
  process.env.NODE_ENV = 'production'
  process.env.MAIL_URL = `smtp://127.0.0.1:${server.port}`
  process.env.MAIL_INSECURE = 'true'
}

const mail = mailer({ from: 'dev@example.com' })

// Loaded before any mail goes, as a server boots.
const before = packages()

if (server) {
  await mail.send({ to: 'ada@example.com', subject: 'Hello', text: 'Hi' })
  server.stop()
}
else {
  await mail.send({ to: 'ada@example.com', subject: 'Hello', text: 'Hi' })
}

if (mode === 'dev')
  await mail.handle(new Request('http://localhost/_kay/mail'))

// The files loaded under node_modules from the package's name, and kayjs-mail's own by their path from src.
function packages(): string[] {
  return Object.keys(require.cache).map(path => PACKAGE_PATH.exec(path)?.[1]).filter(Boolean) as string[]
}

console.log(JSON.stringify({ before, after: packages() }))
process.exit(0)
