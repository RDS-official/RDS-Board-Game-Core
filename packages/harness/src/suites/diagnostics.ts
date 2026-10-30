/* -------------------------------------------------------------------------- */
/* suite:diagnostics — the log ring, redaction and diagnostic bundle           */
/* -------------------------------------------------------------------------- */

import { buildBundle, createBreadcrumbs, createLogRing } from '@rds/web/diagnostics/log';
import { test, assert, assertEqual } from '../testKit';

test('diagnostics: the log ring is bounded, redacts secrets and never throws', () => {
  const ring = createLogRing(3);
  for (let i = 0; i < 5; i += 1) ring.push('info', 'test', `line ${i}`);
  assertEqual(ring.size(), 3, 'the ring keeps only its limit');
  assertEqual(ring.entries()[2].msg, 'line 4', 'the newest entry survives');

  // Credentials must never reach a file.
  ring.push('error', 'auth', 'login failed', { password: 'hunter2', nested: { token: 'abc', keep: 'ok' } });
  const last = ring.entries()[2] as { data?: { password?: string; nested?: { token?: string; keep?: string } } };
  assertEqual(last.data?.password, '[redacted]', 'password is redacted');
  assertEqual(last.data?.nested?.token, '[redacted]', 'nested token is redacted');
  assertEqual(last.data?.nested?.keep, 'ok', 'harmless fields survive');

  // Everything in the bundle has to survive JSON.stringify.
  const crumbs = createBreadcrumbs(2);
  crumbs.add('MOVE_TO_ROOM', true);
  crumbs.add('EXPLORE_DOOR', false, 'illegal action');
  crumbs.add('END_TURN', true);
  assertEqual(crumbs.list().length, 2, 'breadcrumbs are bounded too');

  const bundle = buildBundle({
    build: 'test',
    env: { href: 'http://x', ua: 'node', authorization: 'Bearer secret' },
    logs: ring.entries(),
    breadcrumbs: crumbs.list(),
    state: { phase: 'EXPLORATION', fn: () => 1 }
  });
  const text = JSON.stringify(bundle);
  assert(text.includes('[redacted]'), 'the bundle carries the redaction through');
  assert(!text.includes('hunter2'), 'no raw password anywhere in the bundle');
  assert(!text.includes('Bearer secret'), 'no raw token anywhere in the bundle');
});
