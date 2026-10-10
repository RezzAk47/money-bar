// A strict JSON parser with the Mac app's duplicate-key rule (the FIRST value of a repeated key wins, checked against
// Model.swift: JSON.parse keeps the last). Objects have no prototype, so keys such as "__proto__", "constructor" or
// "toString" are ordinary own keys. Strict on purpose: trailing commas, comments, single quotes and NaN are errors with a
// position (Foundation tolerates a trailing comma; this app reports it and, like any unreadable file, never overwrites it).
const MAX_DEPTH = 512;

export function parseJson(text: string): unknown {
  let i = 0;
  const n = text.length;
  const fail = (msg: string): never => { throw new SyntaxError(`${msg} at position ${i}`); };
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; } };
  const string = (): string => {
    i++; // opening quote
    let out = '', start = i;
    for (;;) {
      if (i >= n) return fail('Unterminated string, end of text');
      const c = text.charCodeAt(i);
      if (c === 34) { out += text.slice(start, i); i++; return out; }
      if (c < 32) return fail('Bad control character in string');
      if (c === 92) {
        out += text.slice(start, i); i++;
        const e = text[i];
        switch (e) {
          case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break;
          case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break; case 'r': out += '\r'; break; case 't': out += '\t'; break;
          case 'u': {
            const h = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) return fail('Bad unicode escape');
            out += String.fromCharCode(parseInt(h, 16)); i += 4; break;
          }
          default: return fail('Bad escape');
        }
        i++; start = i;
      } else i++;
    }
  };
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) return fail('Nested too deeply');
    ws();
    if (i >= n) return fail('Unexpected end of text');
    const c = text[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = Object.create(null);
      ws();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        if (text[i] !== '"') return fail('Expected a string key');
        const k = string();
        ws();
        if (text[i] !== ':') return fail("Expected ':'");
        i++;
        const v = value(depth + 1);
        if (!(k in o)) o[k] = v; // the first value of a repeated key wins
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return o; }
        return fail("Expected ',' or '}'");
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return a; }
        return fail("Expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m) return fail(`Unexpected token ${JSON.stringify(c)}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const v = value(0);
  ws();
  if (i < n) fail('Unexpected data after the value');
  return v;
}
