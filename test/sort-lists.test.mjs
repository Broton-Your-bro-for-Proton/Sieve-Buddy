import assert from 'node:assert/strict';
import test from 'node:test';

import { sortSieveLists } from '../addon/lib/sieve-ast.js';

test('sorts test lists and keeps the layout', () => {
  const src = 'if header :contains "subject" [\n    "Zoo",\n    "apple", # fruit\n    "Mango"\n] { stop; }\n';
  assert.equal(sortSieveLists(src), 'if header :contains "subject" [\n    "apple",\n    "Mango", # fruit\n    "Zoo"\n] { stop; }\n');
});

test('nested tests and header name lists, action lists untouched', () => {
  const src = 'require ["imap4flags", "fileinto"];\nif anyof (address :is ["to", "from"] ["b@x", "a@x"]) { addflag ["\\Seen", "\\Flagged"]; }';
  assert.equal(sortSieveLists(src), 'require ["imap4flags", "fileinto"];\nif anyof (address :is ["from", "to"] ["a@x", "b@x"]) { addflag ["\\Seen", "\\Flagged"]; }');
});

test('matches with variables keeps its order, without variables it sorts', () => {
  const body = 'if header :matches "subject" ["b*", "a*"] { stop; }';
  assert.equal(sortSieveLists(`require "variables";\n${body}`), `require "variables";\n${body}`);
  assert.equal(sortSieveLists(body), 'if header :matches "subject" ["a*", "b*"] { stop; }');
});

test('a range sorts only the lists it touches', () => {
  const src = 'if header :is "x" ["b", "a"] { stop; }\nif header :is "y" ["d", "c"] { stop; }';
  const second = src.indexOf('"y"');
  assert.equal(sortSieveLists(src, second, src.length), 'if header :is "x" ["b", "a"] { stop; }\nif header :is "y" ["c", "d"] { stop; }');
});
