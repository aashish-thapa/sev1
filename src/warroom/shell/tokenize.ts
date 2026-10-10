/** Splits a command line like a POSIX shell would for our purposes: whitespace, single and double quotes. */
export function tokenize(line: string): { tokens: string[]; error?: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasToken = false;

  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (quote) return { tokens, error: `unexpected EOF while looking for matching \`${quote}'` };
  if (hasToken) tokens.push(current);
  return { tokens };
}

/** Reads `--flag=value` / `--flag value` / `-f value`; returns the value and the remaining args. */
export function takeFlag(args: readonly string[], ...names: readonly string[]): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const inline = names.find((name) => arg.startsWith(`${name}=`));
    if (inline) {
      value = arg.slice(inline.length + 1);
    } else if (names.includes(arg)) {
      value = args[index + 1];
      index += 1;
    } else {
      rest.push(arg);
    }
  }
  return { value, rest };
}
