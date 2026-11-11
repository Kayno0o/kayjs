import { describe, expect, it } from 'bun:test'
import { fromPrivateNetwork } from '../src/server/protection'

describe('fromPrivateNetwork', () => {
  it('takes the loopback, private, shared and link-local ranges, mapped ones included', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '100.64.0.1', '169.254.1.1', '::1', '::ffff:10.0.0.1', 'fc00::1', 'fd12:3456::1', 'fdff::', 'fdab::1', 'fe80::1', 'FE80::1', 'febf::1'])
      expect([address, fromPrivateNetwork(address)]).toEqual([address, true])
  })

  it('refuses a public IPv6 address whose first group only starts like a private one', () => {
    // 0fcb::, 0fd::, 0fe8:: and 0feb:: print without their leading zero, and are not unique-local or link-local.
    for (const address of ['fcb::1', 'fd::1', 'fe8::1', 'feb::1', 'fc::', 'fea::1', 'fe80', 'fd', '2001:db8::1', '8.8.8.8', '1.2.3.4'])
      expect([address, fromPrivateNetwork(address)]).toEqual([address, false])
  })
})
