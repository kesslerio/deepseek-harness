/**
 * Process-wide HTTP egress guards for provider requests.
 *
 * Node's global fetch is its built-in undici, and undici arms two defaults no
 * slow LLM request can satisfy: `headersTimeout` and `bodyTimeout`, both
 * 300,000 ms. Streaming endpoints emit response headers immediately and then
 * stay silent for the whole prefill — minutes on a several-hundred-thousand
 * -token prompt — so the built-in defaults kill every such request mid-flight
 * as a bare `terminated` transport error before the adapter's own first-event
 * watchdog (configurable, minutes) can fire. This module installs the
 * process-wide dispatcher those defaults belong to, so timeout ownership over
 * provider responses stays with the harness watchdogs
 * (`firstEventTimeoutMs` / `streamIdleTimeoutMs`).
 *
 * The dispatcher is process-wide because pi-ai constructs its OpenAI clients
 * without a fetch seam (`new OpenAI({ apiKey, baseURL })`), leaving no
 * per-request place to attach one. The guards default to disabled (`0`): every
 * fetch consumer in the process owns its budget through abort signals and
 * timeout policies, and disabling restores the behavior where the caller's own
 * timeout bounds the exchange instead of an undici default.
 *
 * @module dsh-llm-pi-ai/egress
 */

import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Config } from './config.ts'

/** The egress-guard values this module acts on, resolved from the plugin configuration. */
export interface HttpEgressFacts {
  /** Maximum ms between response-body chunks before the dispatcher aborts the exchange; 0 disables the guard. */
  httpBodyTimeoutMs: number
  /** Maximum ms to wait for response headers before the dispatcher aborts the exchange; 0 disables the guard. */
  httpHeadersTimeoutMs: number
}

/** The dispatcher this module installed, when it is still the global one. */
let installedAgent: Agent | undefined
/** The facts {@link installedAgent} was built with. */
let installedFacts: HttpEgressFacts | undefined

/**
 * Report the facts of the dispatcher this module installed, provided that
 * dispatcher is still the process-wide one.
 * @returns the installed facts, or `undefined` once anything else has
 *   replaced the dispatcher.
 */
export function installedHttpEgressFacts(): HttpEgressFacts | undefined {
  return installedAgent !== undefined && installedFacts !== undefined && getGlobalDispatcher() === installedAgent
    ? installedFacts
    : undefined
}

/**
 * Install the process-wide fetch dispatcher carrying these guards. Idempotent:
 * re-calling with unchanged facts while the installed dispatcher still leads
 * the global store reinstalls nothing.
 * @param config - the plugin configuration naming the guard values; absent
 *   fields resolve to disabled.
 * @returns true when a dispatcher was (re)installed.
 */
export function applyHttpEgressGuards(config: Config): boolean {
  const facts: HttpEgressFacts = {
    httpBodyTimeoutMs: config.httpBodyTimeoutMs ?? 0,
    httpHeadersTimeoutMs: config.httpHeadersTimeoutMs ?? 0,
  }
  if (installedAgent !== undefined
    && installedFacts !== undefined
    && getGlobalDispatcher() === installedAgent
    && installedFacts.httpBodyTimeoutMs === facts.httpBodyTimeoutMs
    && installedFacts.httpHeadersTimeoutMs === facts.httpHeadersTimeoutMs) {
    return false
  }
  const agent = new Agent({
    bodyTimeout: facts.httpBodyTimeoutMs,
    headersTimeout: facts.httpHeadersTimeoutMs,
  })
  setGlobalDispatcher(agent)
  installedAgent = agent
  installedFacts = facts
  return true
}
