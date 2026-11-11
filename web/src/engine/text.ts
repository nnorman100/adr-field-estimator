// Walkthrough text the documents keep. Chatter, prices and field names are left out.

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/u;

function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

const CHATTER_PHRASE =
  '(ok|okay|alright|all right|um|uh|hmm|cool|great|perfect|got it|sounds good|thanks|thank you( very much)?|hello|hi|hey|bye|goodbye|good (morning|afternoon|evening)|welcome to the( walkthrough)?|(but )?you get it)';

const CHATTER = new RegExp(
  `^(?:${CHATTER_PHRASE}(?: ${CHATTER_PHRASE})*` +
    '|(?:can|could|may|should) (?:i|we) (?:add|take|attach|send|upload) (?:a |an |another |the |this |more )?' +
    '(?:picture|photo|image)s?|can you hear me|are you (?:there|listening)|did you (?:get|catch) (?:that|it))$',
  'u',
);

const JSON_TERM =
  /\b(the\s+)?(inspection\s+)?JSON(\s+(metadata|data|payload|record|evidence|input|object))?\b/giu;
const METADATA = /\bmetadata\b/giu;
const FIELD_NAME = /\b[a-z]+(?:_[a-z]+)+\b/gu;
const MONEY = /[$€£]|\b(?:usd|dollars?|bucks?|cents?)\b/iu;
const MONEY_WORD = new RegExp(
  String.raw`\b(?:pric(?:e|es|ed|ing)|cost(?:s|ed|ing)?|fees?|charg(?:e|es|ed|ing)|budget(?:s|ed|ing)?` +
    String.raw`|(?:sub)?total(?:s|ed|ing|led|ling)?|quot(?:e|es|ed|ing))\b`,
  'iu',
);
const NUMBER = new RegExp(
  String.raw`\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve` +
    String.raw`|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty` +
    String.raw`|hundred|thousand|million|billion)\b`,
  'iu',
);
const WORDS = /[\p{L}\p{N}_']+/gu;
const SENTENCE_BREAK = /(?<=[.?!])\s+/u;

function words(text: string): string[] {
  return text.toLowerCase().match(WORDS) ?? [];
}

export function sentences(text: string): string[] {
  return text.trim().split(SENTENCE_BREAK).filter(Boolean);
}

function chatter(sentence: string): boolean {
  return CHATTER.test(words(sentence).join(' '));
}

export function technicianStatement(transcript: string): string {
  const kept: string[] = [];
  for (const turn of splitLines(transcript)) {
    const text = sentences(turn)
      .filter((sentence) => !chatter(sentence))
      .join(' ');
    if (text) kept.push(text);
  }
  return kept.join('\n');
}

export function statesPrice(text: string): boolean {
  return MONEY.test(text) || (MONEY_WORD.test(text) && NUMBER.test(text));
}

export function plain(text: string): string {
  const replaced = text.replace(JSON_TERM, (match, ...rest: unknown[]) => {
    const offset = rest[rest.length - 2];
    const first = match[0] ?? '';
    const upper = first !== first.toLowerCase() && first === first.toUpperCase();
    if (offset === 0 && upper) return 'The saved inspection';
    return 'the saved inspection';
  });
  return replaced
    .replace(METADATA, 'record')
    .replace(FIELD_NAME, (match) => match.replaceAll('_', ' '));
}

export function aiNote(text: string): string {
  const lines: string[] = [];
  for (const line of splitLines(text)) {
    const written = sentences(line).map((sentence) => plain(sentence));
    const kept = written.filter((sentence) => !statesPrice(sentence));
    const joined = kept.join(' ');
    if (joined) lines.push(joined);
  }
  return lines.join('\n');
}
