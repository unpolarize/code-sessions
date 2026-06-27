import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  SCHEMA_VERSIONS,
  parseSession,
  type Insights,
  type SessionEnvelope,
  type Signal,
  type Turn,
  type TurnCategory,
} from '@unpolarize/code-sessions-schema';
import type { CodeSessionsConfig } from '../config';
import { envelopeFile, insightsFile } from '../store/paths';
import { listSessionDirs } from '../store/scan';
import { readTurns } from '../store/writer';
import { classifyTurns } from './classifier';
import { deriveIntent, deriveProjects, deriveSignals, deriveTags, guessTopic } from './heuristics';
import { FakeProvider, type LabelResult, type Provider } from './provider';
import { LlmProvider, claudeRunner, grokRunner, ollamaRunner } from './llm';

/** Classifies a session's turns into the configured category taxonomy. */
export type TurnClassifier = (turns: Turn[]) => Promise<TurnCategory[]>;

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function dedupeSignals(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  const out: Signal[] = [];
  for (const s of signals) {
    const key = `${s.kind}:${s.turn_index ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export interface LabelOptions {
  /** ISO timestamp for the insights record (injectable for deterministic tests) */
  now?: string;
  /** when set, classifies each turn into a configured category and stores the result */
  classify?: TurnClassifier;
}

/**
 * Build the per-turn classifier configured in cfg, or undefined when classification
 * is disabled / no category taxonomy is set. Always uses the local ollama runner.
 */
export function makeTurnClassifier(cfg: CodeSessionsConfig): TurnClassifier | undefined {
  const { categories, classifyTurns: enabled, classifierModel, model } = cfg.insights;
  if (!enabled || !categories || categories.length === 0) return undefined;
  const runner = ollamaRunner(classifierModel ?? model);
  return (turns) => classifyTurns(turns, categories, runner);
}

/** Build the provider configured in cfg, or null when insights are disabled. */
export function makeProvider(cfg: CodeSessionsConfig): Provider | null {
  const { provider, model } = cfg.insights;
  switch (provider) {
    case 'none':
      return null;
    case 'fake':
      return new FakeProvider();
    case 'claude':
      return new LlmProvider('claude', claudeRunner(model));
    case 'grok':
      return new LlmProvider('grok', grokRunner(model));
    case 'ollama':
      return new LlmProvider('ollama', ollamaRunner(model));
    default:
      return null;
  }
}

/**
 * Label one session: deterministic heuristics + the configured provider, written
 * to insights/labels.json and reflected as envelope labels. Provider failures
 * degrade gracefully to heuristics-only.
 */
export async function labelSession(
  sessionDir: string,
  identity: { sessionId: string; host: string },
  provider: Provider,
  opts: LabelOptions = {},
): Promise<Insights | undefined> {
  const turns = readTurns(sessionDir);
  if (turns.length === 0) return undefined;

  const heuristicSignals = deriveSignals(turns);
  let provided: LabelResult = { tags: [], projects: [], signals: [] };
  try {
    provided = await provider.label({ sessionId: identity.sessionId, host: identity.host, turns });
  } catch {
    // provider unavailable (no CLI / API) — heuristics still apply
  }

  const topic = provided.topic ?? guessTopic(turns);
  const intent = provided.intent ?? deriveIntent(turns);
  const tags = [...new Set([...provided.tags, ...deriveTags(turns)])].slice(0, 16);
  const projects = [...new Set([...provided.projects, ...deriveProjects(turns)])].slice(0, 16);
  const signals = dedupeSignals([...heuristicSignals, ...provided.signals]);

  const insights: Insights = {
    schema: SCHEMA_VERSIONS.insights,
    session_id: identity.sessionId,
    host: identity.host,
    generated_at: opts.now ?? new Date().toISOString(),
    provider: provider.name,
    tags,
    projects,
    signals,
    turn_categories: [],
  };
  if (topic) insights.topic = topic;
  if (intent) insights.intent = intent;
  if (provided.summary) insights.summary = provided.summary;
  if (opts.classify) {
    const categories = await opts.classify(turns);
    if (categories.length > 0) insights.turn_categories = categories;
  }

  writeJsonAtomic(insightsFile(sessionDir), insights);
  updateEnvelopeLabels(sessionDir, { topic, intent, projects });
  return insights;
}

function updateEnvelopeLabels(
  sessionDir: string,
  l: { topic?: string; intent?: string; projects: string[] },
): void {
  const path = envelopeFile(sessionDir);
  if (!existsSync(path)) return;
  let env: SessionEnvelope;
  try {
    env = parseSession(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return;
  }
  env.labels = [
    ...new Set([
      ...(l.intent ? [`intent:${l.intent}`] : []),
      ...(l.topic ? [l.topic] : []),
      ...l.projects.map((p) => `project:${p}`),
    ]),
  ].slice(0, 16);
  writeJsonAtomic(path, env);
}

export interface ReindexResult {
  count: number;
  sessions: string[];
}

/** Re-label every session in the store (optionally since a month). Post-processing path. */
export async function reindexStore(
  cfg: CodeSessionsConfig,
  provider: Provider,
  opts: { sinceMonth?: string; now?: string } = {},
): Promise<ReindexResult> {
  const refs = listSessionDirs(cfg.storeDir, opts.sinceMonth ? { sinceMonth: opts.sinceMonth } : {});
  const classify = makeTurnClassifier(cfg);
  const labeled: string[] = [];
  for (const ref of refs) {
    const labelOpts: LabelOptions = {};
    if (opts.now) labelOpts.now = opts.now;
    if (classify) labelOpts.classify = classify;
    const res = await labelSession(ref.dir, { sessionId: ref.sessionId, host: ref.host }, provider, labelOpts);
    if (res) labeled.push(ref.sessionId);
  }
  return { count: labeled.length, sessions: labeled };
}
