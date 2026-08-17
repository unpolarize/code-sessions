export const SESSION_LINK_AUTHORITY = 'zhirafovod.code-sessions';
export const SESSION_LINK_PATH = '/open';

export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionLinkView = 'csv' | 'cb';

export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim());
}

export function formatSessionUri(link: {
  session: string;
  view?: SessionLinkView;
  host?: string;
}): string {
  const params = new URLSearchParams();
  params.set('session', link.session.trim());
  if (link.view && link.view !== 'csv') params.set('view', link.view);
  if (link.host) params.set('host', link.host);
  return `vscode://${SESSION_LINK_AUTHORITY}${SESSION_LINK_PATH}?${params.toString()}`;
}
