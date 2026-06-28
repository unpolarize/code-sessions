import { describe, expect, it } from 'vitest';
import { resolveIdentity, type IdentityDeps } from './identity';

function deps(over: Partial<IdentityDeps> = {}): IdentityDeps {
  return { gitUser: () => ({}), osUser: () => undefined, ...over };
}

describe('resolveIdentity', () => {
  it('prefers git user.email, then user.name, then OS user', () => {
    expect(
      resolveIdentity(undefined, {}, deps({ gitUser: () => ({ email: 'a@x.com', name: 'A' }), osUser: () => 'os' }))
        .enduser,
    ).toBe('a@x.com');
    expect(resolveIdentity(undefined, {}, deps({ gitUser: () => ({ name: 'A' }), osUser: () => 'os' })).enduser).toBe('A');
    expect(resolveIdentity(undefined, {}, deps({ osUser: () => 'os' })).enduser).toBe('os');
  });

  it('lets an explicit config enduser override resolution', () => {
    const id = resolveIdentity(undefined, { enduser: 'svc' }, deps({ gitUser: () => ({ email: 'a@x.com' }) }));
    expect(id.enduser).toBe('svc');
  });

  it('queries git user from the resolved repo root', () => {
    let askedRoot: string | undefined = 'unset';
    const d = deps({
      gitUser: (root) => {
        askedRoot = root;
        return { email: 'r@x.com' };
      },
    });
    expect(resolveIdentity({ label: 'acme/app', root: '/work/acme' }, {}, d).enduser).toBe('r@x.com');
    expect(askedRoot).toBe('/work/acme');
  });

  it('omits attributes that resolve to nothing', () => {
    expect(resolveIdentity(undefined, {}, deps())).toEqual({});
  });
});
