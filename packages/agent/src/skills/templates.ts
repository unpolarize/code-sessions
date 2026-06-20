import { INTENTS, SIGNAL_KINDS } from '@unpolarize/code-sessions-schema';

/**
 * The canonical "label a session" skill, generated from the CS labels taxonomy
 * so it never drifts from the schema. Installed into each agent so it (or the
 * daemon's configured provider) can label topics, intent, projects-touched, and
 * signals, emitting the exact JSON the CS insights pipeline ingests.
 */
export function buildLabelSkillBody(): string {
  return `You are labeling a coding-agent session for the code-sessions (CS) store.

Read the provided session transcript and emit ONLY a single JSON object — no prose, no code fence:

\`\`\`json
{
  "topic": "3-6 word summary of what the session was about",
  "intent": "one of: ${INTENTS.join(' | ')}",
  "tags": ["short", "themes", "or", "tool", "names"],
  "projects": ["repo-or-dir-names-touched"],
  "signals": [
    { "kind": "one of: ${SIGNAL_KINDS.join(' | ')}", "severity": "info|warn|critical", "note": "why" }
  ],
  "summary": "one sentence"
}
\`\`\`

Guidance:
- **intent** = what the user wanted (a feature, a bug fixed, a refactor, research, docs, ops, a review, a chore).
- **projects** = the projects/repos the session actually edited (from file paths it wrote to), not everything mentioned.
- **signals** = only notable ones: stuck loops, error-recovery, unusually high cost, very long sessions, tool-heavy stretches, strong negative/positive affect.
- Keep it terse and machine-parseable. Output the JSON and nothing else.`;
}

/** Claude SKILL.md with frontmatter. */
export function buildClaudeSkill(): string {
  return `---
name: cs-label-session
description: Label a coding session (topic, intent, tags, projects touched, signals) as JSON for the code-sessions store. Use when asked to classify or summarize a session.
---

${buildLabelSkillBody()}
`;
}

/** Codex / Grok plain prompt file (no frontmatter). */
export function buildPromptFile(): string {
  return `# cs-label-session\n\n${buildLabelSkillBody()}\n`;
}
