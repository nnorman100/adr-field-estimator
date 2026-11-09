// Python str and re semantics: Unicode whitespace, digits, word characters, code-point lengths and
// IGNORECASE matching, so text checks and filters treat every character as the reference does.

export const PY_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WORD = '\\p{L}\\p{N}_';
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu');
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, 'u');
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/u;
const DIGIT = /\p{Nd}/u;

/** Code points, the unit of Python's len() and pydantic's string lengths. */
export function chars(value: string): number {
  return Array.from(value).length;
}

/** str.isprintable(): no control, format, surrogate, private, unassigned or separator characters but space. */
export function printable(text: string): boolean {
  return !/[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u.test(text);
}

export function pyStrip(text: string): string {
  return text.replace(STRIP, '');
}

export function pySplit(text: string): string[] {
  return text.split(SPACE_RUN).filter(Boolean);
}

export function pyLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** Unicode decimal digits as ASCII, the digits Python's Decimal and int read. */
export function asciiDigits(text: string): string {
  let out = '';
  for (const char of text) {
    if (char > '\u007f' && DIGIT.test(char)) {
      let start = char.codePointAt(0) ?? 0;
      while (DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
      out += String(((char.codePointAt(0) ?? 0) - start) % 10);
    } else out += char;
  }
  return out;
}

const FOLD: Record<string, string> = {
  '\u00df': 'ss',
  '\u0149': '\u02bcn',
  '\u017f': 's',
  '\u01f0': 'j\u030c',
  '\u0345': '\u03b9',
  '\u1e96': 'h\u0331',
  '\u1e97': 't\u0308',
  '\u1e98': 'w\u030a',
  '\u1e99': 'y\u030a',
  '\u1e9a': 'a\u02be',
  '\u1e9e': 'ss',
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
};

/** str.casefold() wherever it differs from lower() in ASCII letters or word characters. */
export function casefold(text: string): string {
  let out = '';
  for (const char of text) out += Object.hasOwn(FOLD, char) ? FOLD[char] : char.toLowerCase();
  return out;
}

/**
 * A Python re pattern as a JavaScript Unicode regex: \d, \w, \s and \b keep their Unicode meaning,
 * and with "i" an i also matches the dotted capital and dotless i, as Python's IGNORECASE does.
 */
export function pyRe(source: string, flags = ''): RegExp {
  const ignoreCase = flags.includes('i');
  let out = '';
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (char === '\\') {
      const next = source[index + 1] ?? '';
      index += 1;
      if (next === 'd') out += '\\p{Nd}';
      else if (next === 'w') out += inClass ? WORD : `[${WORD}]`;
      else if (next === 's') out += inClass ? PY_SPACE : `[${PY_SPACE}]`;
      else if (next === 'b' && !inClass)
        out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
      else out += `\\${next}`;
    } else if (char === '[' && !inClass) {
      inClass = true;
      out += char;
    } else if (char === ']' && inClass) {
      inClass = false;
      out += char;
    } else if (ignoreCase && (char === 'i' || char === 'I')) {
      out += inClass ? 'iI\u0130\u0131' : '[iI\u0130\u0131]';
    } else out += char;
  }
  return new RegExp(out, `${flags}u`);
}
