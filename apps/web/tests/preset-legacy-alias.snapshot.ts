/** Restores a stored legacy preset identity through the shipped Web Host composition. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { generationLogPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'

const fixturePath = fileURLToPath(new URL('../../../snapshots/web/preset-legacy-alias/session.v3.jsonl', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('legacy preset restoration through the Web Host', () => {
  it.each(['cordis-trimmed', 'unrecognized'])('restores only configured preset identities (%s)', async (agentPreset) => {
    const scaffold = await launchWebScaffold()
    try {
      const id = SessionId('6234b9ef-da38-4a85-a3ca-73175108a642')
      const [fixtureHeader] = (await readFile(fixturePath, 'utf8')).trimEnd().split('\n')
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      if (fixtureHeader === undefined) throw new Error('legacy preset fixture has no Session header')
      const header = { ...fixtureHeader, id, cwd: scaffold.workspaceCwd, agentPreset }
      const path = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, id, SESSION_FORMAT_VERSION, 'zstd')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')))

      const resumed = await scaffold.ctx.sessionController.resolveAgent(id)
      if (agentPreset === 'unrecognized') {
        expect(resumed).toMatchObject({ error: { code: 'gateway/internal' } })
        if (!('error' in resumed)) throw new Error('unknown preset was resumed')
        expect(resumed.error.message).toContain('preset "unrecognized" not found')
        expect(scaffold.ctx.agents.get(id)).toBeUndefined()
        return
      }
      if ('error' in resumed) throw resumed.error
      expect(scaffold.ctx.agentPresets.composedPreset(resumed.agent.ctx)).toBe('cordis')
      expect(resumed.agent.session.header.agentPreset).toBe('cordis-trimmed')
    } finally {
      await scaffold.close()
    }
  })
})
