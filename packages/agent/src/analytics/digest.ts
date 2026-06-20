import type { AnalyticsReport } from './rollup';

/** Render a human-readable Markdown digest from an analytics report. */
export function renderDigest(report: AnalyticsReport): string {
  const lines: string[] = [];
  lines.push('# Session digest');
  lines.push('');
  lines.push(`_Generated ${report.generated_at}_`);
  lines.push('');
  lines.push(`- **Sessions:** ${report.sessions}`);
  lines.push(
    `- **Tokens:** ${report.totals.input_tokens.toLocaleString()} in / ${report.totals.output_tokens.toLocaleString()} out`,
  );
  lines.push(`- **Estimated cost:** $${report.totals.cost_usd.toFixed(2)}`);
  lines.push(`- **Hosts:** ${Object.entries(report.hosts).map(([h, n]) => `${h} (${n})`).join(', ') || '—'}`);
  lines.push('');

  if (report.topTopics.length) {
    lines.push('## Top topics');
    for (const t of report.topTopics) lines.push(`- ${t.topic} — ${t.count}`);
    lines.push('');
  }
  if (report.topTags.length) {
    lines.push('## Top tags');
    lines.push(report.topTags.map((t) => `\`${t.tag}\` (${t.count})`).join(' · '));
    lines.push('');
  }
  if (Object.keys(report.signalCounts).length) {
    lines.push('## Signals');
    for (const [kind, count] of Object.entries(report.signalCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${kind}: ${count}`);
    }
    lines.push('');
  }
  if (report.similar.length) {
    lines.push('## Related sessions (shared tags)');
    for (const s of report.similar) lines.push(`- \`${s.tag}\`: ${s.sessions.length} sessions`);
    lines.push('');
  }
  if (Object.keys(report.byMonth).length) {
    lines.push('## By month');
    for (const [month, m] of Object.entries(report.byMonth).sort()) {
      lines.push(`- ${month}: ${m.sessions} sessions, $${m.cost_usd.toFixed(2)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
