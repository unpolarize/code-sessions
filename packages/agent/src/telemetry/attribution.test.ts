import { describe, expect, it } from 'vitest';
import type { Insights, SessionEnvelope, Turn } from '@unpolarize/code-sessions-schema';
import { RepoResolver } from '../insights/repo';
import { sessionAttribution } from './attribution';

function turn(i: number, over: Partial<Turn> = {}): Turn {
  return {
    schema: 'session-store/turn@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    turn_index: i,
    ts: 't',
    role: 'assistant',
    text: '',
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    scrubbed: false,
    raw_ref: null,
    ...over,
  };
}

function envelope(over: Partial<SessionEnvelope> = {}): SessionEnvelope {
  return {
    schema: 'session-store/session@1',
    session_id: 's',
    host: 'h',
    agent: 'claude-code',
    project_path: '',
    turn_count: 0,
    tool_call_count: 0,
    totals: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    labels: [],
    planning_refs: [],
    native_ref: { format: 'claude-jsonl', uuid: 's' },
    ...over,
  };
}

const insightsBase: Insights = {
  schema: 'session-store/insights@1',
  session_id: 's',
  host: 'h',
  generated_at: 't',
  provider: 'fake',
  tags: [],
  projects: [],
  signals: [],
  turn_categories: [],
};

describe('sessionAttribution', () => {
  it('composes dominant repo, identity, per-project association properties, and insights intent/topic', () => {
    const resolver = new RepoResolver({
      isGitRoot: (d) => d === '/work/acme',
      remoteUrl: () => 'git@github.com:acme/app.git',
    });
    const identity = { gitUser: () => ({ email: 'dev@acme.com' }), osUser: () => 'dev' };
    const turns = [turn(0, { tool_calls: [{ name: 'Edit', input: { file_path: '/work/acme/src/x.ts' } }] })];
    const insights: Insights = { ...insightsBase, intent: 'feature', topic: 'payments api' };

    const a = sessionAttribution(
      envelope({ project_path: '/work/acme' }),
      turns,
      insights,
      {
        custom: { 'cost.center': 'cc-1', env: 'dev' },
        // per-project properties override/extend the global ones when the dominant project matches
        customByRepo: { 'acme/app': { env: 'prod', tenant: 'acme' } },
      },
      { resolver, identity },
    );

    expect(a).toEqual({
      repo: 'acme/app',
      repoUrl: 'git@github.com:acme/app.git',
      enduser: 'dev@acme.com',
      custom: { 'cost.center': 'cc-1', env: 'prod', tenant: 'acme' },
      intent: 'feature',
      topic: 'payments api',
    });
  });

  it('degrades to identity-only when no repo resolves and there are no insights', () => {
    const resolver = new RepoResolver({ isGitRoot: () => false, remoteUrl: () => undefined });
    const identity = { gitUser: () => ({}), osUser: () => 'ci' };
    const a = sessionAttribution(envelope(), [], undefined, {}, { resolver, identity });
    expect(a).toEqual({ enduser: 'ci' });
  });

  it('passes configured custom attributes through verbatim', () => {
    const resolver = new RepoResolver({ isGitRoot: () => false, remoteUrl: () => undefined });
    const identity = { gitUser: () => ({}), osUser: () => 'ci' };
    const a = sessionAttribution(
      envelope(),
      [],
      undefined,
      { custom: { env: 'prod', 'cost.center': 'cc-1' } },
      { resolver, identity },
    );
    expect(a.custom).toEqual({ env: 'prod', 'cost.center': 'cc-1' });
  });
});
