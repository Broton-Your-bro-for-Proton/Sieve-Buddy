import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the manager links to Ko-fi statically, without a widget script', () => {
  const html = readFileSync(new URL('../addon/manager/manager.html', import.meta.url), 'utf8');
  assert.match(html, /<a class="support-link" href="https:\/\/ko-fi\.com\/hypercrisis" rel="noreferrer" target="_blank">/);
  assert.doesNotMatch(html, /ko-fi\.com\/cdn|kofiwidget/);
});

test('the coffee icon stays outside the link underline', () => {
  const css = readFileSync(new URL('../addon/manager/manager.css', import.meta.url), 'utf8');
  assert.match(css, /\.support-link::before \{[^}]*display: inline-block/);
});
