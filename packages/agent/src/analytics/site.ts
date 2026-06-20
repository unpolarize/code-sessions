import type { AnalyticsReport } from './rollup';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Render a minimal, dependency-free static HTML dashboard from the report. */
export function renderSite(report: AnalyticsReport): string {
  const rows = (pairs: [string, string | number][]): string =>
    pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('');

  const topics = report.topTopics.map((t) => `<li>${esc(t.topic)} — ${t.count}</li>`).join('');
  const tags = report.topTags.map((t) => `<span class="tag">${esc(t.tag)} (${t.count})</span>`).join(' ');
  const signals = Object.entries(report.signalCounts)
    .map(([k, v]) => `<li>${esc(k)}: ${v}</li>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>code-sessions — analytics</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:720px;color:#111}
  h1{margin-bottom:.2rem} .muted{color:#666}
  table{border-collapse:collapse;margin:1rem 0} td{padding:.2rem .8rem;border-bottom:1px solid #eee}
  .tag{display:inline-block;background:#eef;border-radius:4px;padding:.1rem .4rem;margin:.1rem}
  ul{margin:.3rem 0}
</style></head><body>
<h1>code-sessions</h1>
<div class="muted">analytics · generated ${esc(report.generated_at)}</div>
<table>${rows([
    ['Sessions', report.sessions],
    ['Input tokens', report.totals.input_tokens],
    ['Output tokens', report.totals.output_tokens],
    ['Estimated cost (USD)', report.totals.cost_usd.toFixed(2)],
  ])}</table>
<h2>Top topics</h2><ul>${topics || '<li class="muted">none</li>'}</ul>
<h2>Top tags</h2><div>${tags || '<span class="muted">none</span>'}</div>
<h2>Signals</h2><ul>${signals || '<li class="muted">none</li>'}</ul>
</body></html>
`;
}
