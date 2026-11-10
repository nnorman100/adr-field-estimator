// The exact JSON text Python stored for one value of an oracle file, with only the whitespace
// outside strings removed. Expected answers are compared as this text, never re-serialized.

const SPACE = new Set([' ', '\t', '\n', '\r']);

class Scanner {
  index = 0;
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  at(): string {
    return this.text[this.index] ?? '';
  }

  space(): void {
    while (SPACE.has(this.at())) this.index += 1;
  }

  string(): string {
    const start = this.index;
    this.index += 1;
    while (this.at() !== '"') {
      if (this.index >= this.text.length) throw new Error('Unterminated string');
      if (this.at() === '\\') this.index += 1;
      this.index += 1;
    }
    this.index += 1;
    return this.text.slice(start, this.index);
  }

  value(): void {
    this.space();
    const open = this.at();
    if (open === '"') {
      this.string();
      return;
    }
    if (open === '{' || open === '[') {
      const close = open === '{' ? '}' : ']';
      this.index += 1;
      this.space();
      if (this.at() === close) {
        this.index += 1;
        return;
      }
      for (;;) {
        if (open === '{') {
          this.space();
          this.string();
          this.space();
          this.index += 1;
        }
        this.value();
        this.space();
        const mark = this.at();
        this.index += 1;
        if (mark === close) return;
        if (mark !== ',') throw new Error('Expected comma');
      }
    }
    const start = this.index;
    while (this.index < this.text.length && !',]}'.includes(this.at()) && !SPACE.has(this.at())) {
      this.index += 1;
    }
    if (start === this.index) throw new Error('Expected value');
  }

  enter(key: string | number): boolean {
    this.space();
    const open = this.at();
    this.index += 1;
    this.space();
    let position = 0;
    while (this.at() !== '}' && this.at() !== ']') {
      if (open === '{') {
        const name = JSON.parse(this.string()) as string;
        this.space();
        this.index += 1;
        if (name === key) return true;
      } else if (position === key) return true;
      this.value();
      this.space();
      if (this.at() === ',') this.index += 1;
      this.space();
      position += 1;
    }
    return false;
  }
}

function withoutSpace(raw: string): string {
  let out = '';
  let inString = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        index += 1;
        out += raw[index] ?? '';
      } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (!SPACE.has(char)) out += char;
  }
  return out;
}

/** The stored text at `path`, or null when the path is absent. */
export function storedJson(text: string, path: Array<string | number>): string | null {
  const scanner = new Scanner(text);
  for (const key of path) {
    if (!scanner.enter(key)) return null;
  }
  scanner.space();
  const start = scanner.index;
  scanner.value();
  return withoutSpace(text.slice(start, scanner.index));
}
