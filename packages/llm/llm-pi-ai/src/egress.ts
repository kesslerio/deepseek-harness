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
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
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
 * Whether a proxy policy currently owns the global fetch dispatcher.
 *
 * `dsh-http-proxy` documents itself as owning undici's global dispatcher, and
 * its Agent carries a per-origin factory that routes proxied requests through a
 * proxy — something a bare `new Agent({ bodyTimeout, headersTimeout })` loses.
 * Replacing that dispatcher here would silently bypass a corporate proxy, so when
 * the proxy package has a policy installed for a scheme this module yields to it
 * and installs nothing.
 * @returns true when a proxy policy would route a request it is asked about.
 */
function proxyPolicyActive(): boolean {
  try {
    return proxyRouteFor(new URL('https://dsh-egress-probe.invalid')).proxied
      || proxyRouteFor(new URL('http://dsh-egress-probe.invalid')).proxied
  } catch {
    // The proxy package is present (this module imports it) but no policy is
    // installed, or routing threw: treat it as direct and install our guards.
    return false
  }
}

/**
 * Resolve the egress-guard values a configuration requests. The config schema
 * defaults both fields to `0`, so in a validated configuration they are always
 * numbers; this still narrows the optional interface for callers that pass an
 * unvalidated object.
 * @param config - the configuration naming the guard values.
 * @returns the guard facts, with absent fields disabled.
 */
export function resolveHttpEgressFacts(config: Config): HttpEgressFacts {
  return {
    httpBodyTimeoutMs: config.httpBodyTimeoutMs ?? 0,
    httpHeadersTimeoutMs: config.httpHeadersTimeoutMs ?? 0,
  }
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
  const facts = resolveHttpEgressFacts(config)
  if (installedAgent !== undefined
    && installedFacts !== undefined
    && getGlobalDispatcher() === installedAgent
    && installedFacts.httpBodyTimeoutMs === facts.httpBodyTimeoutMs
    && installedFacts.httpHeadersTimeoutMs === facts.httpHeadersTimeoutMs) {
    return false
  }
  // A proxy policy owns the dispatcher for routing; replacing it would break
  // proxying, so yield. The proxy dispatcher keeps undici's default timeouts —
  // a known limitation recorded in the README.
  if (proxyPolicyActive()) return false
  const agent = new Agent({
    bodyTimeout: facts.httpBodyTimeoutMs,
    headersTimeout: facts.httpHeadersTimeoutMs,
  })
  setGlobalDispatcher(agent)
  installedAgent = agent
  installedFacts = facts
  return true
}
