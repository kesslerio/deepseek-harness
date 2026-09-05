/**
 * Coverage and behavior for the egress guards' coordination with the proxy
 * package and their own state reporting. These branches are not exercised by
 * the timeout behavior tests, which run against the direct path.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Agent, setGlobalDispatcher } from 'undici'
import { hasProxyPolicy } from '@deepseek-ai/dsh-http-proxy'
import { Config } from '../src/config.ts'
import { applyHttpEgressGuards, installedHttpEgressFacts, resolveHttpEgressFacts } from '../src/egress.ts'

vi.mock('@deepseek-ai/dsh-http-proxy', () => ({ hasProxyPolicy: vi.fn(() => false) }))
const proxyMock = hasProxyPolicy as Mock

beforeEach(() => {
  proxyMock.mockReset()
  proxyMock.mockReturnValue(false)
  setGlobalDispatcher(new Agent())
})

afterEach(() => {
  setGlobalDispatcher(new Agent())
})

describe('egress guard proxy coordination', () => {
  it('reports undefined facts before any guard is installed', () => {
    expect(installedHttpEgressFacts()).toBeUndefined()
  })

  it('yields to an active proxy policy and installs nothing', () => {
    proxyMock.mockReturnValue(true)
    expect(applyHttpEgressGuards(Config({}))).toBe(false)
    // The proxy owns the dispatcher; our guard left it alone.
    expect(installedHttpEgressFacts()).toBeUndefined()
  })

  it('yields when any proxy policy is installed', () => {
    proxyMock.mockReturnValue(true)
    expect(applyHttpEgressGuards(Config({}))).toBe(false)
  })

  it('installs when proxy routing throws', () => {
    proxyMock.mockImplementation(() => { throw new Error('proxy down') })
    expect(applyHttpEgressGuards(Config({}))).toBe(true)
    expect(installedHttpEgressFacts()).toEqual({ httpBodyTimeoutMs: 0, httpHeadersTimeoutMs: 0 })
  })

  it('carries explicit timeout values into the installed facts', () => {
    expect(applyHttpEgressGuards(Config({ httpBodyTimeoutMs: 250, httpHeadersTimeoutMs: 250 }))).toBe(true)
    expect(installedHttpEgressFacts()).toEqual({ httpBodyTimeoutMs: 250, httpHeadersTimeoutMs: 250 })
  })

  it('resolves disabled facts from a configuration that lacks the fields', () => {
    // An unvalidated configuration object (no schema default) exercises the
    // nullish-narrowing branch of the resolver.
    expect(resolveHttpEgressFacts({})).toEqual({ httpBodyTimeoutMs: 0, httpHeadersTimeoutMs: 0 })
  })

  it('installs guards from an unvalidated configuration without throwing', () => {
    expect(applyHttpEgressGuards({})).toBe(true)
    expect(installedHttpEgressFacts()).toEqual({ httpBodyTimeoutMs: 0, httpHeadersTimeoutMs: 0 })
  })
})
