import { existsSync, readFileSync } from 'node:fs';
import {
  safeParseInsights,
  safeParseSession,
  type Insights,
  type SessionEnvelope,
} from '@unpolarize/code-sessions-schema';
import { envelopeFile, insightsFile } from '../store/paths';
import { listSessionDirs, type SessionRef } from '../store/scan';

export interface LoadedSession {
  ref: SessionRef;
  envelope?: SessionEnvelope;
  insights?: Insights;
}

export function loadSession(ref: SessionRef): LoadedSession {
  const out: LoadedSession = { ref };
  const envPath = envelopeFile(ref.dir);
  if (existsSync(envPath)) {
    try {
      const parsed = safeParseSession(JSON.parse(readFileSync(envPath, 'utf8')));
      if (parsed.success) out.envelope = parsed.data;
    } catch {
      /* ignore */
    }
  }
  const insPath = insightsFile(ref.dir);
  if (existsSync(insPath)) {
    try {
      const parsed = safeParseInsights(JSON.parse(readFileSync(insPath, 'utf8')));
      if (parsed.success) out.insights = parsed.data;
    } catch {
      /* ignore */
    }
  }
  return out;
}

export interface AnalyticsReport {
  generated_at: string;
  sessions: number;
  hosts: Record<string, number>;
  totals: { input_tokens: number; output_tokens: number; cost_usd: number };
  byMonth: Record<string, { sessions: number; cost_usd: number }>;
  topTopics: { topic: string; count: number }[];
  topTags: { tag: string; count: number }[];
  signalCounts: Record<string, number>;
  similar: { tag: string; sessions: string[] }[];
}

function topN(counts: Map<string, number>, n: number): { count: number; key: string }[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, n);
}

/** Crunch all stored sessions into a single analytics report (the "backend brain", server-free). */
export function computeReport(storeDir: string, now: string): AnalyticsReport {
  const refs = listSessionDirs(storeDir);
  const loaded = refs.map(loadSession);

  const hosts: Record<string, number> = {};
  const byMonth: Record<string, { sessions: number; cost_usd: number }> = {};
  const totals = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const topicCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const tagToSessions = new Map<string, string[]>();
  const signalCounts: Record<string, number> = {};

  for (const { ref, envelope, insights } of loaded) {
    hosts[ref.host] = (hosts[ref.host] ?? 0) + 1;
    const month = (byMonth[ref.month] ??= { sessions: 0, cost_usd: 0 });
    month.sessions++;
    if (envelope) {
      totals.input_tokens += envelope.totals.input_tokens;
      totals.output_tokens += envelope.totals.output_tokens;
      totals.cost_usd += envelope.totals.cost_usd;
      month.cost_usd += envelope.totals.cost_usd;
    }
    if (insights) {
      if (insights.topic) topicCounts.set(insights.topic, (topicCounts.get(insights.topic) ?? 0) + 1);
      for (const tag of insights.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        (tagToSessions.get(tag) ?? tagToSessions.set(tag, []).get(tag)!).push(ref.sessionId);
      }
      for (const sig of insights.signals) {
        signalCounts[sig.kind] = (signalCounts[sig.kind] ?? 0) + 1;
      }
    }
  }

  totals.cost_usd = Math.round(totals.cost_usd * 1e6) / 1e6;
  for (const m of Object.values(byMonth)) m.cost_usd = Math.round(m.cost_usd * 1e6) / 1e6;

  const similar = [...tagToSessions.entries()]
    .filter(([, s]) => s.length >= 2)
    .map(([tag, sessions]) => ({ tag, sessions: [...new Set(sessions)] }))
    .sort((a, b) => b.sessions.length - a.sessions.length)
    .slice(0, 10);

  return {
    generated_at: now,
    sessions: loaded.length,
    hosts,
    totals,
    byMonth,
    topTopics: topN(topicCounts, 10).map(({ key, count }) => ({ topic: key, count })),
    topTags: topN(tagCounts, 15).map(({ key, count }) => ({ tag: key, count })),
    signalCounts,
    similar,
  };
}
