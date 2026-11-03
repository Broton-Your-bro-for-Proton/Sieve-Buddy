// Copies the third-party browser files the add-on needs from node_modules into addon/vendor.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'addon', 'vendor');

const files = {
  'bcryptjs/dist/bcrypt.min.js': 'bcrypt.min.js',
  'bcryptjs/LICENSE': 'bcryptjs.LICENSE',
  'codemirror/lib/codemirror.js': 'codemirror/codemirror.js',
  'codemirror/lib/codemirror.css': 'codemirror/codemirror.css',
  'codemirror/mode/sieve/sieve.js': 'codemirror/sieve.js',
  'codemirror/addon/lint/lint.js': 'codemirror/lint.js',
  'codemirror/addon/lint/lint.css': 'codemirror/lint.css',
  'codemirror/addon/hint/show-hint.js': 'codemirror/show-hint.js',
  'codemirror/addon/hint/show-hint.css': 'codemirror/show-hint.css',
  'codemirror/addon/edit/matchbrackets.js': 'codemirror/matchbrackets.js',
  'codemirror/addon/edit/closebrackets.js': 'codemirror/closebrackets.js',
  'codemirror/addon/comment/comment.js': 'codemirror/comment.js',
  'codemirror/LICENSE': 'codemirror/LICENSE',
};

rmSync(vendor, { recursive: true, force: true });
for (const [from, to] of Object.entries(files)) {
  const target = join(vendor, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, 'node_modules', from), target);
}
console.log(`Vendored ${Object.keys(files).length} files into addon/vendor`);
