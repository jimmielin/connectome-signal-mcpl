import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToSignal, toTextStyleArgs } from '../src/markdown.js';

const render = (md: string) => {
  const r = markdownToSignal(md);
  return { text: r.text, styles: toTextStyleArgs(r.styles).sort() };
};
const slice = (md: string) => {
  const r = markdownToSignal(md);
  return r.styles.map((s) => `${s.style}:${r.text.slice(s.start, s.start + s.length)}`).sort();
};

test('plain text passes through untouched', () => {
  assert.deepEqual(render('hello there'), { text: 'hello there', styles: [] });
});

test('bold, italic, strike, spoiler, code', () => {
  assert.deepEqual(slice('a **b** *c* ~~d~~ ||e|| `f`'), [
    'BOLD:b', 'ITALIC:c', 'MONOSPACE:f', 'SPOILER:e', 'STRIKETHROUGH:d',
  ]);
  assert.equal(markdownToSignal('a **b** *c* ~~d~~ ||e|| `f`').text, 'a b c d e f');
});

test('nested styles', () => {
  const r = markdownToSignal('*it **both** it*');
  assert.equal(r.text, 'it both it');
  assert.deepEqual(slice('*it **both** it*'), ['BOLD:both', 'ITALIC:it both it']);
});

test('snake_case and arithmetic stay literal', () => {
  assert.deepEqual(render('use my_var_name and 2 * 3 * 4'), { text: 'use my_var_name and 2 * 3 * 4', styles: [] });
});

test('unclosed delimiters stay literal', () => {
  assert.deepEqual(render('a **b and *c'), { text: 'a **b and *c', styles: [] });
});

test('code span content is not parsed', () => {
  assert.deepEqual(slice('`**x**`'), ['MONOSPACE:**x**']);
});

test('escapes', () => {
  assert.deepEqual(render('\\*not italic\\*'), { text: '*not italic*', styles: [] });
});

test('fenced code block', () => {
  const r = markdownToSignal('before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter');
  assert.equal(r.text, 'before\nconst a = 1;\nconst b = 2;\nafter');
  assert.deepEqual(slice('before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter'), ['MONOSPACE:const a = 1;\nconst b = 2;']);
});

test('unclosed fence renders as code', () => {
  assert.deepEqual(slice('```\nx = 1'), ['MONOSPACE:x = 1']);
});

test('headings and bullets', () => {
  const r = markdownToSignal('## Plan\n- one\n* **two**');
  assert.equal(r.text, 'Plan\n• one\n• two');
  assert.deepEqual(slice('## Plan\n- one\n* **two**'), ['BOLD:Plan', 'BOLD:two']);
});

test('links keep the url', () => {
  assert.equal(markdownToSignal('see [docs](https://x.y/z)').text, 'see docs (https://x.y/z)');
  assert.equal(markdownToSignal('[https://x.y](https://x.y)').text, 'https://x.y');
});

test('offsets are UTF-16 code units (emoji before a style)', () => {
  const r = markdownToSignal('🌸 **bloom**');
  assert.equal(r.text, '🌸 bloom');
  assert.deepEqual(toTextStyleArgs(r.styles), ['3:5:BOLD']);
});

test('unmatched backtick runs stay literal', () => {
  assert.deepEqual(render('``a` and b'), { text: '``a` and b', styles: [] });
});
