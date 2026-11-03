// `kay push keys`: prints a fresh VAPID key pair as the two lines the environment takes.
import type { KayCommand } from '../commands/command'
import { generateVapidKeys } from './push-crypto'

const command: KayCommand = {
  usage: 'push keys',
  options: {},
  refuses: { 'quiet': 'prints only the two lines asked for', 'dry-run': 'writes nothing' },
  positionals: 0,
  run: async (_parsed, _refuse, { format, result }) => {
    const { publicKey, privateKey } = await generateVapidKeys()

    result({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey })

    if (format === 'json')
      return 0

    console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
    console.log(`VAPID_PRIVATE_KEY=${privateKey}`)

    return 0
  },
}

export default command
