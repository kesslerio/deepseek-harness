/**
 * Behavioral guards for the process-wide HTTP egress dispatcher
 * (`src/egress.ts`): undici's built-in 300,000 ms headers/body defaults must
 * no longer kill provider exchanges, while a configured finite guard still
 * does. Servers here stall on purpose, so every wait is bounded well under
 * undici's 1s fast-timer granularity for finite guards and far below its
 * 300s defaults for the disabled ones.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { Config } from '../src/config.ts'
import { applyHttpEgressGuards } from '../src/egress.ts'

const servers: Server[] = []
let dispatcherTouched = false

/** A server that answers headers immediately and then never writes again. */
async function stallingBodyServer(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': headers only\n\n')
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

/** A server that accepts connections and never answers at all. */
async function silentServer(): Promise<string> {
  const server = createServer(() => {})
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

/** Race a response body against a deadline, reporting how it ended. */
async function bodyOutcome(url: string, withinMs: number): Promise<string> {
  const response = await fetch(`${url}/chat/completions`, { method: 'POST', body: '{}' })
  const body = response.body
  if (body === null) return 'no body stream'
  return Promise.race([
    (async () => {
      try {
        for await (const _chunk of body) void _chunk
        return 'ended cleanly'
      } catch (error) {
        const code = (error as { cause?: { code?: string } }).cause?.code
        return `aborted with ${code ?? 'unknown code'}`
      }
    })(),
    new Promise<string>((resolve) => { setTimeout(() => { resolve('still streaming') }, withinMs) }),
  ])
}

afterEach(async () => {
  // The stalled responses hold their sockets open, so close() alone would
  // wait on them; destroy the connections first.
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  // Restore the undici defaults so later files in the same worker observe the
  // behavior they were written against.
  if (dispatcherTouched) {
    setGlobalDispatcher(new Agent())
    dispatcherTouched = false
  }
})

describe('http egress guards', () => {
  it('leaves a stalled response body alive under the disabled default', async () => {
    dispatcherTouched = applyHttpEgressGuards(Config({}))
    const url = await stallingBodyServer()
    await expect(bodyOutcome(url, 1300)).resolves.toBe('still streaming')
  })

  it('aborts a stalled response body at the configured bound', async () => {
    dispatcherTouched = applyHttpEgressGuards(Config({ httpBodyTimeoutMs: 100 }))
    const url = await stallingBodyServer()
    await expect(bodyOutcome(url, 1500)).resolves.toBe('aborted with UND_ERR_BODY_TIMEOUT')
  })

  it('aborts a request whose headers never arrive at the configured bound', async () => {
    dispatcherTouched = applyHttpEgressGuards(Config({ httpHeadersTimeoutMs: 100 }))
    const url = await silentServer()
    const outcome = await Promise.race([
      (async () => {
        try {
          await fetch(`${url}/chat/completions`, { method: 'POST', body: '{}' })
          return 'answered'
        } catch (error) {
          const code = (error as { code?: string; cause?: { code?: string } })
          return `aborted with ${code.code ?? code.cause?.code ?? 'unknown code'}`
        }
      })(),
      new Promise<string>((resolve) => { setTimeout(() => { resolve('still waiting') }, 1500) }),
    ])
    expect(outcome).toBe('aborted with UND_ERR_HEADERS_TIMEOUT')
  })

  it('reinstalls only when the facts change', async () => {
    dispatcherTouched = applyHttpEgressGuards(Config({})) || dispatcherTouched
    const first = getGlobalDispatcher()
    expect(applyHttpEgressGuards(Config({}))).toBe(false)
    expect(getGlobalDispatcher()).toBe(first)
    expect(applyHttpEgressGuards(Config({ httpBodyTimeoutMs: 250 }))).toBe(true)
    expect(getGlobalDispatcher()).not.toBe(first)
  })
})
