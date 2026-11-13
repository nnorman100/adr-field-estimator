// What a span may say about a SQL statement: its type and the table it names, and nothing else.
// Never the text, which can hold a literal, and never a parameter. Best effort on purpose: the
// first table after FROM, INTO or UPDATE. A statement with none (SELECT set_config(...)) has none.

const OPERATIONS = new Set([
  'select', 'insert', 'update', 'delete', 'with', 'set', 'show', 'begin', 'commit', 'rollback',
  'savepoint', 'release', 'create', 'alter', 'drop', 'truncate', 'lock', 'call', 'copy', 'explain',
  'listen', 'notify', 'prepare', 'execute', 'deallocate', 'reset', 'grant', 'revoke',
]);

const NAME = String.raw`(?:"[^"]{1,63}"|[A-Za-z_][\w$]{0,62})`;
// An optional schema, then the table: `"public"."jobs"`, `jobs`.
const TABLE = String.raw`(?:${NAME}\s*\.\s*)?(${NAME})`;
const TABLE_AFTER: Record<string, RegExp> = {
  select: new RegExp(String.raw`\bfrom\s+${TABLE}`, 'i'),
  with: new RegExp(String.raw`\b(?:from|into|update)\s+${TABLE}`, 'i'),
  insert: new RegExp(String.raw`^insert\s+into\s+${TABLE}`, 'i'),
  update: new RegExp(String.raw`^update\s+(?:only\s+)?${TABLE}`, 'i'),
  delete: new RegExp(String.raw`^delete\s+from\s+(?:only\s+)?${TABLE}`, 'i'),
};
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const LEADING = /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*/;

export type StatementKind = { operation: string; table?: string };

export function statementKind(text: string | null | undefined): StatementKind {
  if (typeof text !== 'string') return { operation: 'other' };
  const body = text.replace(LEADING, '');
  const word = /^[A-Za-z]+/.exec(body)?.[0]?.toLowerCase() ?? '';
  const operation = OPERATIONS.has(word) ? word : 'other';
  const found = TABLE_AFTER[operation]?.exec(body)?.[1]?.replace(/^"|"$/g, '');
  return found !== undefined && PLAIN_NAME.test(found)
    ? { operation: operation.toUpperCase(), table: found }
    : { operation: operation.toUpperCase() };
}
