// `kay push keys`: prints a fresh VAPID key pair as the two lines the environment takes.
import type { KayCommand } from '../commands/command'
import { generateVapidKeys } from './push-crypto'

const command: KayCommand = {
  usage: 'push keys',
  options: {},
  positionals: 0,
  run: async () => {
    const { publicKey, privateKey } = await generateVapidKeys()

    console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
    console.log(`VAPID_PRIVATE_KEY=${privateKey}`)

    return 0
  },
}

export default command
