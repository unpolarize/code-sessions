import { createHash } from 'node:crypto';
import type { Turn } from '@unpolarize/code-sessions-schema';

/**
 * Hygiene at the door (the Codex 1.95 GB lesson): secret-scrub, cap per-turn
 * size, externalize giant tool outputs. Runs before any write.
 */

export interface SecretMatch {
  kind: string;
  count: number;
}

interface Pattern {
  kind: string;
  re: RegExp;
}

// Ordered, specific-first. All global so we can count + replace every hit.
const PATTERNS: Pattern[] = [
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/** Redact known secret shapes in text. Returns redacted text + per-kind counts. */
export function scrubSecrets(text: string): { text: string; matches: SecretMatch[] } {
  let out = text;
  const matches: SecretMatch[] = [];
  for (const { kind, re } of PATTERNS) {
    let count = 0;
    out = out.replace(re, () => {
      count++;
      return `[REDACTED:${kind}]`;
    });
    if (count > 0) matches.push({ kind, count });
  }
  return { text: out, matches };
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface HygieneOptions {
  maxTurnBytes: number;
  scrubSecrets: boolean;
}

export interface HygieneResult {
  turn: Turn;
  /** present when the turn's text was externalized: persist content at raw/<sha> */
  blob?: { sha: string; content: string };
  redactions: SecretMatch[];
}

const PREVIEW_CHARS = 280;

/**
 * Apply hygiene to a turn (pure: returns a new turn, never mutates input).
 * - scrub secrets in text (and drop verbatim `raw` if anything was redacted, so
 *   the unredacted secret is not preserved);
 * - externalize oversized text to a content-addressed blob, leaving a preview.
 */
export function applyHygiene(turn: Turn, opts: HygieneOptions): HygieneResult {
  let text = turn.text;
  let scrubbed = turn.scrubbed;
  let raw = turn.raw;
  const redactions: SecretMatch[] = [];

  if (opts.scrubSecrets) {
    const res = scrubSecrets(text);
    if (res.matches.length > 0) {
      text = res.text;
      scrubbed = true;
      raw = undefined; // never retain the unredacted copy
      redactions.push(...res.matches);
    }
  }

  let blob: { sha: string; content: string } | undefined;
  let rawRef = turn.raw_ref;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > opts.maxTurnBytes) {
    const sha = sha256(text);
    blob = { sha, content: text };
    rawRef = sha;
    raw = undefined; // the big content lives in the blob, not duplicated in raw
    const preview = text.slice(0, PREVIEW_CHARS);
    text = `${preview}\n…[externalized ${bytes}B → raw/${sha}]`;
  }

  const next: Turn = {
    ...turn,
    text,
    scrubbed,
    raw_ref: rawRef,
    ...(raw === undefined ? { raw: undefined } : { raw }),
  };
  return { turn: next, ...(blob ? { blob } : {}), redactions };
}
