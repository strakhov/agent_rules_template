import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules', 'copilot-instructions_LEGACY.md']);

function readDocuments(directory, prefix = '') {
  const documents = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory()) {
      for (const [name, text] of readDocuments(path.join(directory, entry.name), `${relative}/`)) {
        documents.set(name, text);
      }
    } else if (entry.name.endsWith('.md')) {
      documents.set(relative, readFileSync(path.join(directory, entry.name), 'utf8'));
    }
  }
  return documents;
}

function validate(documents) {
  const errors = [];
  for (const required of ['AGENTS.md', 'PROJECT.md', 'rules/WORKFLOW.md', 'rules/CONTROLS.md']) {
    if (!documents.has(required)) errors.push(`Missing required file: ${required}`);
  }
  for (const [name, text] of documents) {
    if (text.includes('\uFFFD')) errors.push(`${name}: invalid UTF-8 replacement character`);
    if (/^ +$/m.test(text)) errors.push(`${name}: whitespace-only line`);
    let insideFence = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('```')) {
        insideFence = !insideFence;
        continue;
      }
      if (insideFence) continue;
      for (const match of line.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
        let decoded;
        try {
          decoded = decodeURIComponent(target);
        } catch {
          errors.push(`${name}: invalid link encoding: ${target}`);
          continue;
        }
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), decoded));
        if (decoded.includes('\\') || decoded.startsWith('/') || resolved.startsWith('../')) {
          errors.push(`${name}: nonportable link: ${target}`);
        } else if (resolved.endsWith('.md') && !documents.has(resolved)) {
          errors.push(`${name}: missing Markdown target: ${target}`);
        }
      }
    }
    if (insideFence) errors.push(`${name}: unclosed code fence`);
  }
  const core = documents.get('AGENTS.md') ?? '';
  if (core.trimEnd().split(/\r?\n/).length > 60) errors.push('AGENTS.md exceeds 60 lines');
  if (!core.includes('(PROJECT.md)')) errors.push('AGENTS.md must link to PROJECT.md');
  return errors;
}

function selfTest() {
  const fixture = new Map([
    ['AGENTS.md', '[Profile](PROJECT.md)\n'],
    ['PROJECT.md', '# Profile\n'],
    ['rules/WORKFLOW.md', '# Workflow\n'],
    ['rules/CONTROLS.md', '# Controls\n'],
  ]);
  assert.deepEqual(validate(fixture), []);
  const cases = [
    ['[Broken](missing.md)', 'missing Markdown target'],
    ['[Escape](../outside.md)', 'nonportable link'],
    ['[Bad](bad%XX.md)', 'invalid link encoding'],
    ['```text\nunfinished', 'unclosed code fence'],
    ['\uFFFD', 'invalid UTF-8'],
  ];
  for (const [text, expected] of cases) {
    const changed = new Map(fixture);
    changed.set('PROJECT.md', text);
    assert.ok(validate(changed).some(error => error.includes(expected)), expected);
  }
  const missing = new Map(fixture);
  missing.delete('rules/CONTROLS.md');
  assert.ok(validate(missing).some(error => error.includes('Missing required file')));
  const oversized = new Map(fixture);
  oversized.set('AGENTS.md', '[Profile](PROJECT.md)\n' + 'rule\n'.repeat(60));
  assert.ok(validate(oversized).some(error => error.includes('exceeds 60 lines')));
  console.log('PASS: validator self-test (valid fixture and 7 negative cases)');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  selfTest();
} else if (args.length > 0) {
  console.error('Usage: node tools/validate.mjs [--self-test]');
  process.exitCode = 2;
} else {
  const documents = readDocuments(root);
  const errors = validate(documents);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${documents.size} Markdown files; required files, links, fences, encoding, core size`);
  }
}