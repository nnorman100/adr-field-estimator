// A reader for the flat HCL that infra/dryscope/*/envs/*.tfvars hold: `name = value` lines whose
// values are strings, numbers, booleans, lists and objects, with #, // and /* */ comments. Anything
// else (an expression, a function call, a heredoc, a repeated name) is refused rather than guessed
// at, so a test that reads a setting through it reads what Terraform would.

export type TfValue = string | number | boolean | TfValue[] | { [name: string]: TfValue };

const TOKEN =
  /\s+|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|-?\d+(?:\.\d+)?(?![\w.])|[A-Za-z_][\w-]*|[={}[\],]|./gy;

function tokens(text: string): string[] {
  const out: string[] = [];
  for (const [token] of text.matchAll(TOKEN)) {
    if (
      /^\s/.test(token) ||
      token.startsWith('#') ||
      token.startsWith('//') ||
      token.startsWith('/*')
    ) {
      continue;
    }
    out.push(token);
  }
  return out;
}

export function parseTfvars(text: string): { [name: string]: TfValue } {
  const list = tokens(text);
  let at = 0;
  const fail = (what: string): never => {
    throw new Error(`tfvars: ${what} at token ${at} (${JSON.stringify(list[at] ?? 'end')})`);
  };
  const next = () => list[at++] ?? fail('unexpected end');
  const expect = (token: string) => (next() === token ? undefined : fail(`expected ${token}`));

  function body(end: string | null): { [name: string]: TfValue } {
    const found: { [name: string]: TfValue } = {};
    while (end === null ? at < list.length : list[at] !== end) {
      const name = next();
      if (!/^[A-Za-z_][\w-]*$/.test(name) || name === 'true' || name === 'false')
        fail('expected a name');
      if (Object.hasOwn(found, name)) fail(`${name} given twice`);
      expect('=');
      found[name] = value();
      if (list[at] === ',') at++;
    }
    if (end !== null) expect(end);
    return found;
  }

  function value(): TfValue {
    const token = next();
    if (token === '{') return body('}');
    if (token === '[') {
      const items: TfValue[] = [];
      while (list[at] !== ']') {
        items.push(value());
        if (list[at] !== ']') expect(',');
      }
      at++;
      return items;
    }
    if (token === 'true' || token === 'false') return token === 'true';
    if (/^-?\d/.test(token)) return Number(token);
    if (token.startsWith('"')) {
      if (token.includes('${') || token.includes('%{')) fail('a template expression');
      return JSON.parse(token) as string;
    }
    return fail('an unsupported value');
  }

  return body(null);
}
