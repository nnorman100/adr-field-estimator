// Fails when a prompt text that docs/ai-inventory.md pins changes without the inventory changing
// with it. The texts come from scripts/ai_inventory_facts.py (no model call); this file hashes every
// prompt text itself, so the two sides compute independently.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = path.join(ROOT, 'docs', 'ai-inventory.md');
const UPDATE =
  'If the change is intended, run `python3 scripts/ai_inventory_facts.py --table`, paste the rows ' +
  'into docs/ai-inventory.md, and describe the change in the pull request.';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readFacts() {
  for (const python of ['python3', 'python', 'py']) {
    const result = spawnSync(python, ['-I', 'scripts/ai_inventory_facts.py'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error && result.error.code === 'ENOENT') continue;
    if (result.status !== 0) throw new Error(`${python} failed:\n${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  throw new Error('No Python interpreter found (tried python3, python, py).');
}

// Rows of the first table that starts with the given header cell, up to the next blank line.
function tableRows(markdown, header) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`| ${header} |`));
  if (start < 0) throw new Error(`docs/ai-inventory.md has no "${header}" table.`);
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, '|'));
    rows.push(cells.map((cell) => cell.replace(/^`|`$/g, '')));
  }
  return rows;
}

// What differs between the inventory and the code, as readable lines; empty when they agree.
function compare(markdown, facts) {
  const problems = [];
  const pinned = new Map(tableRows(markdown, 'Prompt id').map(([id, , hash]) => [id, hash]));
  for (const [id, item] of Object.entries(facts.prompts)) {
    if (!pinned.has(id)) problems.push(`Prompt ${id} (${item.source}) is not in the inventory.`);
    else if (pinned.get(id) !== sha256(item.text))
      problems.push(`Prompt ${id} (${item.source}) changed: now ${sha256(item.text)}.`);
  }
  for (const id of pinned.keys())
    if (!(id in facts.prompts)) problems.push(`Inventory prompt ${id} no longer exists.`);
  return problems;
}

const markdown = fs.readFileSync(INVENTORY, 'utf8');
const facts = readFacts();

test('every pinned prompt hash matches the prompt text', () => {
  const problems = compare(markdown, facts);
  expect(problems, `${problems.join('\n')}\n${UPDATE}`).toEqual([]);
});

test('a changed, a new and a removed prompt are all reported', () => {
  const changed = structuredClone(facts);
  changed.prompts['ocr.instructions'].text += ' ';
  changed.prompts['new.prompt'] = { source: 'somewhere', text: 'new' };
  delete changed.prompts['transcribe.instructions'];
  const problems = compare(markdown, changed).join('\n');
  expect(problems).toContain('Prompt ocr.instructions');
  expect(problems).toContain('Prompt new.prompt');
  expect(problems).toContain('Inventory prompt transcribe.instructions no longer exists');
});

test('the hash is a standard SHA-256 of the UTF-8 text', () => {
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(sha256('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
});

test('the inventory stays under 1,000 lines and keeps the open owner decision marked', () => {
  expect(markdown.split('\n').length).toBeLessThan(1000);
  expect(markdown).toMatch(/PENDING OWNER DECISION R2/);
  expect(markdown).toMatch(/Model Armor/);
});

test('docs/AI.md links to the inventory', () => {
  const index = fs.readFileSync(path.join(ROOT, 'docs', 'AI.md'), 'utf8');
  expect(index).toContain('(ai-inventory.md)');
});
