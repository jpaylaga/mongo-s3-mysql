import { readFile } from 'node:fs/promises';

/**
 * Offset of the first byte a JSON parser cannot accept. V8's message no longer carries a position
 * and its snippet would echo the text, which may hold a pasted secret, so a small scanner finds the
 * spot instead.
 */
function errorOffset(raw: string): number {
  let i = 0;

  const fail = (): never => {
    throw i;
  };

  const ws = () => {
    while (i < raw.length && ' \t\n\r'.includes(raw[i] as string)) i += 1;
  };

  const expect = (s: string) => {
    if (raw.startsWith(s, i)) i += s.length;
    else fail();
  };

  const string = () => {
    expect('"');

    for (;;) {
      if (i >= raw.length) fail();

      const ch = raw[i] as string;

      if (ch === '"') {
        i += 1;

        return;
      }

      if (ch === '\\') {
        i += 1;

        if (raw[i] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) fail();

          i += 5;
        } else if ('"\\/bfnrt'.includes(raw[i] ?? '')) i += 1;
        else fail();

        continue;
      }

      if (ch < ' ') fail();

      i += 1;
    }
  };

  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(raw.slice(i));

    if (!m) fail();

    i += (m as RegExpExecArray)[0].length;
  };

  const value = (): void => {
    ws();

    const ch = raw[i];

    if (ch === '{') {
      i += 1;
      ws();

      if (raw[i] === '}') {
        i += 1;

        return;
      }

      for (;;) {
        ws();
        string();
        ws();
        expect(':');
        value();
        ws();

        if (raw[i] === ',') {
          i += 1;

          continue;
        }

        expect('}');

        return;
      }
    }

    if (ch === '[') {
      i += 1;
      ws();

      if (raw[i] === ']') {
        i += 1;

        return;
      }

      for (;;) {
        value();
        ws();

        if (raw[i] === ',') {
          i += 1;

          continue;
        }

        expect(']');

        return;
      }
    }

    if (ch === '"') return string();

    if (ch === 't') return expect('true');

    if (ch === 'f') return expect('false');

    if (ch === 'n') return expect('null');

    number();
  };

  try {
    value();
    ws();

    if (i < raw.length) fail();

    return raw.length;
  } catch (at) {
    return typeof at === 'number' ? at : raw.length;
  }
}

const lineCol = (raw: string, offset: number): string => {
  const before = raw.slice(0, offset);

  return `${before.split('\n').length}:${offset - before.lastIndexOf('\n')}`;
};

/**
 * The config file as a parsed object: the position-only error and nothing of the text itself, which
 * may hold a pasted secret.
 */
export default async function readConfigObject(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  // Editors on some platforms write a byte order mark; mapping files and S3 records drop it the
  // same way.
  const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${path}:${lineCol(raw, errorOffset(raw))}: invalid JSON`);
  }
}
