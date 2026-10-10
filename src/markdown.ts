/**
 * Markdown → Signal body ranges.
 *
 * Signal renders no markdown. It styles text with explicit ranges
 * (`start:length:STYLE`, sent as signal-cli's `textStyle`), where start and
 * length are UTF-16 code units — which is exactly what JS string indices are,
 * so offsets here are plain `.length` arithmetic.
 *
 * The goal is "what the agent wrote reads the way it meant it", not a
 * CommonMark implementation. Supported: **bold** / __bold__, *italic* /
 * _italic_, ~~strike~~, ||spoiler||, `code`, fenced code blocks, # headings
 * (bold line), - / * bullets (•), [text](url) links, and backslash escapes.
 * Anything that doesn't parse cleanly is left as literal text, never dropped.
 */

export type SignalStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';

export interface StyleRange {
  start: number;
  length: number;
  style: SignalStyle;
}

export interface StyledText {
  text: string;
  styles: StyleRange[];
}

/** signal-cli `textStyle` argument values. */
export function toTextStyleArgs(styles: StyleRange[]): string[] {
  return styles.map((s) => `${s.start}:${s.length}:${s.style}`);
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(?=\S)/;
const ESCAPABLE = /[\\`*_~|[\]()#>+\-.!]/;
const WORD = /[\p{L}\p{N}_]/u;

export function markdownToSignal(input: string): StyledText {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const blocks: StyledText[] = [];
  let code: string[] | null = null;
  let fence = '';

  const flushCode = () => {
    const body = code!.join('\n');
    blocks.push({ text: body, styles: body.length > 0 ? [{ start: 0, length: body.length, style: 'MONOSPACE' }] : [] });
    code = null;
  };

  for (const line of lines) {
    const fm = FENCE.exec(line);
    if (code !== null) {
      if (fm && fm[1] === fence) flushCode();
      else code.push(line);
      continue;
    }
    if (fm) {
      code = [];
      fence = fm[1];
      continue;
    }

    const hm = HEADING.exec(line);
    if (hm) {
      const inner = parseInline(hm[1]);
      if (inner.text.length > 0) inner.styles.push({ start: 0, length: inner.text.length, style: 'BOLD' });
      blocks.push(inner);
      continue;
    }

    const bm = BULLET.exec(line);
    if (bm) {
      blocks.push(prefix(`${bm[1]}\u2022 `, parseInline(line.slice(bm[0].length))));
      continue;
    }

    blocks.push(parseInline(line));
  }
  // An unclosed fence still renders as code rather than losing its styling.
  if (code !== null) flushCode();

  let text = '';
  const styles: StyleRange[] = [];
  blocks.forEach((b, i) => {
    if (i > 0) text += '\n';
    const base = text.length;
    text += b.text;
    for (const st of b.styles) styles.push({ ...st, start: st.start + base });
  });
  return { text, styles };
}

function prefix(p: string, part: StyledText): StyledText {
  return { text: p + part.text, styles: part.styles.map((s) => ({ ...s, start: s.start + p.length })) };
}

interface Delim {
  token: string;
  style: SignalStyle;
  /** Underscore rules: no intraword open/close (snake_case stays literal). */
  intrawordGuard: boolean;
}

// Longer tokens first so `**` wins over `*`.
const DELIMS: Delim[] = [
  { token: '**', style: 'BOLD', intrawordGuard: false },
  { token: '__', style: 'BOLD', intrawordGuard: true },
  { token: '~~', style: 'STRIKETHROUGH', intrawordGuard: false },
  { token: '||', style: 'SPOILER', intrawordGuard: false },
  { token: '*', style: 'ITALIC', intrawordGuard: false },
  { token: '_', style: 'ITALIC', intrawordGuard: true },
];

export function parseInline(s: string): StyledText {
  let text = '';
  const styles: StyleRange[] = [];
  let i = 0;

  outer: while (i < s.length) {
    const ch = s[i];

    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const close = s.indexOf(run, i + run.length);
      let inner = close === -1 ? '' : s.slice(i + run.length, close);
      if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ')) inner = inner.slice(1, -1);
      if (inner.length > 0) {
        styles.push({ start: text.length, length: inner.length, style: 'MONOSPACE' });
        text += inner;
        i = close + run.length;
      } else {
        // Unmatched (or empty) run: keep the whole run literal.
        text += run;
        i += run.length;
      }
      continue;
    }

    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        const label = parseInline(m[1]);
        const base = text.length;
        text += label.text;
        for (const st of label.styles) styles.push({ ...st, start: st.start + base });
        if (label.text !== m[2]) text += ` (${m[2]})`;
        i += m[0].length;
        continue;
      }
    }

    for (const d of DELIMS) {
      if (!s.startsWith(d.token, i)) continue;
      const openEnd = i + d.token.length;
      const after = s[openEnd];
      if (after === undefined || /\s/.test(after)) continue;
      if (d.intrawordGuard && i > 0 && WORD.test(s[i - 1])) continue;
      const close = findClose(s, openEnd, d);
      if (close < 0) continue;
      const inner = parseInline(s.slice(openEnd, close));
      const base = text.length;
      text += inner.text;
      for (const st of inner.styles) styles.push({ ...st, start: st.start + base });
      if (inner.text.length > 0) styles.push({ start: base, length: inner.text.length, style: d.style });
      i = close + d.token.length;
      continue outer;
    }

    text += ch;
    i++;
  }

  return { text, styles };
}

/** Index of the closing delimiter for `d` at or after `from`, or -1. Skips
 *  code spans and escapes, and for single-char tokens skips doubled runs so
 *  `*a **b** c*` closes at the last `*`. */
function findClose(s: string, from: number, d: Delim): number {
  let j = from;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(j))![0];
      const end = s.indexOf(run, j + run.length);
      if (end !== -1) { j = end + run.length; continue; }
    }
    if (s.startsWith(d.token, j)) {
      if (d.token.length === 1 && s[j + 1] === d.token) {
        // A doubled run inside a single-char span is a nested strong span.
        j += 2;
        continue;
      }
      const before = s[j - 1];
      const next = s[j + d.token.length];
      const okBefore = j > from && before !== undefined && !/\s/.test(before);
      const okAfter = !d.intrawordGuard || next === undefined || !WORD.test(next);
      if (okBefore && okAfter) return j;
    }
    j++;
  }
  return -1;
}
