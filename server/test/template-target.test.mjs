// Template snippets with target "auto" never go into a disabled filter (it would never run).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDialect, newScript } from '../../addon/lib/sieve-dialect.js';
import { buildTemplate } from '../src/ops.js';

test('a snippet template skips a disabled first filter', async () => {
  const scripts = [
    { id: 'off', name: 'Old', enabled: false, sieve: newScript('') },
    { id: 'on', name: 'Main', enabled: true, sieve: newScript('') },
  ];
  const account = { data: async () => ({ dialect: makeDialect({ name: 'proton' }), capabilities: { multipleActive: true }, scripts, folders: null, labels: [] }) };
  const planned = await buildTemplate(account, { templateId: 'vacation', params: { subject: 'Away', text: 'Back on Monday' } });
  assert.equal(planned.target.id, 'on');
});
