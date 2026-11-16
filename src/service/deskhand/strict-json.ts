const maximumTextBytes = 5_400_000;
const maximumDepth = 64;

export function parseJsonRejectingDuplicateKeys(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > maximumTextBytes) throw new Error('json-limit');
  let offset = 0;
  const whitespace = () => {
    while (offset < text.length && /[\x20\t\r\n]/.test(text[offset])) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== 'string') throw new Error('json-string');
        return value;
      }
      if (character === '\\') offset++;
    }
    throw new Error('json-string');
  };
  const value = (depth: number): void => {
    if (depth > maximumDepth) throw new Error('json-depth');
    whitespace();
    const character = text[offset];
    if (character === '"') { string(); return; }
    if (character === '{' || character === '[') {
      offset++;
      const object = character === '{';
      const close = object ? '}' : ']';
      const keys = new Set<string>();
      whitespace();
      if (text[offset] === close) { offset++; return; }
      while (offset < text.length) {
        whitespace();
        if (object) {
          if (text[offset] !== '"') throw new Error('json-key');
          const key = string();
          if (keys.has(key)) throw new Error('json-duplicate');
          keys.add(key);
          whitespace();
          if (text[offset++] !== ':') throw new Error('json-colon');
        }
        value(depth + 1);
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === close) return;
        if (delimiter !== ',') throw new Error('json-delimiter');
      }
      throw new Error('json-close');
    }
    const start = offset;
    while (offset < text.length && !/[\x20\t\r\n,}\]]/.test(text[offset])) offset++;
    if (offset === start) throw new Error('json-value');
  };
  value(0);
  whitespace();
  if (offset !== text.length) throw new Error('json-tail');
  return JSON.parse(text);
}
