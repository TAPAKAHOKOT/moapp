import { describe, expect, it } from 'vitest'
import { parseCapabilityHash } from './capability'

describe('capability parsing', () => {
  it('recognizes only exact supported fragment routes', () => {
    expect(parseCapabilityHash(`#/join/${'A'.repeat(43)}`)).toEqual({ kind: 'invite', token: 'A'.repeat(43) })
    expect(parseCapabilityHash(`#/join/${'A'.repeat(42)}`)).toBeNull()
    expect(parseCapabilityHash(`#/join/${'A'.repeat(43)}/extra`)).toBeNull()
    expect(parseCapabilityHash('#/unknown/token')).toBeNull()
  })
})
