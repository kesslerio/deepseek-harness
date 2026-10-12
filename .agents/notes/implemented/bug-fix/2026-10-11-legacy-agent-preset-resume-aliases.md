# Agent Note: Legacy Agent preset resume aliases

Status: implemented

English | [中文](2026-10-11-legacy-agent-preset-resume-aliases.zh.md)

## Problem

Session logs preserve the selected preset ID. When an upgrade replaces a preset definition under a new ID, cold resume asks the registry for the old ID and refuses the session.

## Decision

The preset registry accepts explicit `legacyAliases` from stored IDs to current IDs. A discovered preset under the requested ID takes precedence; otherwise the registry resolves its configured alias for lookup, document reads, mounting, and the selected default. Aliases do not appear in the preset roster. The Web profile maps `cordis-trimmed` to `cordis`, the current shipped composition. Resume uses the current `cordis` composition and leaves the persisted session identity unchanged. An absent alias target and any other unknown ID still produce `agent-preset/not-found`.

## Alternatives considered

**Rewrite the affected session header.** A one-session data repair restores only that record and leaves other stored sessions with the same legacy ID unable to resume.

**Declare a second preset with the old ID.** Duplicating the composition would publish the old identity as a separate roster choice and could drift from the current definition.

## Consequences

Compatibility remains explicit in the profile that owns the old ID. Existing session logs need no rewrite, and aliases do not change the current preset roster. Other IDs remain strict: the registry rejects missing definitions and aliases whose targets are absent.

## Testing

Filesystem registry tests cover canonical resolution, mounting, precedence, roster omission, and unknown-ID refusal. A keyless Web Host snapshot resumes a synthetic Session v3 fixture under the reported session ID with the stored `cordis-trimmed` header and verifies that its live Agent uses `cordis`.
