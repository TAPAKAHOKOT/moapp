import type { CapabilityIntent } from './types'

let pendingIntent: CapabilityIntent | null = null

// Tokens are base64url secrets. This only rejects obviously malformed values;
// the server remains the authority for expiry/consumption.
const tokenPattern = /^[A-Za-z0-9_-]{43,128}$/
const prefixes: ReadonlyArray<readonly [string, CapabilityIntent['kind']]> = [
  ['#/join/', 'invite'], ['#/device/', 'device'], ['#/recover/', 'recovery'],
]

export function parseCapabilityHash(hash: string): CapabilityIntent | null {
  for (const [prefix, kind] of prefixes) {
    if (!hash.startsWith(prefix)) continue
    const token = hash.slice(prefix.length)
    return tokenPattern.test(token) ? { kind, token } as CapabilityIntent : null
  }
  return null
}

/** Extracts a capability before app/SW startup and removes it from browser history. */
export function consumeCapabilityFromLocation(location: Pick<Location, 'hash'> = window.location): CapabilityIntent | null {
  const intent = parseCapabilityHash(location.hash)
  if (!intent) return null
  pendingIntent = intent
  if (typeof history !== 'undefined') history.replaceState(history.state, '', '/')
  return intent
}

/** For bootstrap code that needs the already-consumed in-memory intent. */
export function takeCapabilityIntent(): CapabilityIntent | null {
  const intent = pendingIntent
  pendingIntent = null
  return intent
}
