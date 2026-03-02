const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseChapters,
  getChapterAtOffset,
} = require('../public/chapters');

test('acceptance: basic split', () => {
  const input = 'One.\n\n---\nTitle\nText.';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 2);
  assert.equal(input.slice(parsed[0].startOffset, parsed[0].endOffset), 'One.\n\n');
  assert.equal(parsed[1].dividerStyle, '---');
  assert.ok(parsed[1].title);
  assert.equal(parsed[1].title.text, 'Title');
});

test('acceptance: coalesces consecutive dividers', () => {
  const input = 'A\n\n---\n---\n\nB';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].startOffset, input.indexOf('B'));
  assert.equal(input.slice(parsed[0].startOffset, parsed[0].endOffset), 'A\n\n');
});

test('acceptance: divider whitespace tolerance + title detection', () => {
  const input = 'A\n \n  -*-  \n  \nT\nX';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].dividerStyle, '-*-');
  assert.ok(parsed[1].title);
  assert.equal(parsed[1].title.text, 'T');
});

test('acceptance: first non-empty line after divider becomes title', () => {
  const input = 'A\n\n*\n\n\nB';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 2);
  assert.ok(parsed[1].title);
  assert.equal(parsed[1].title.text, 'B');
  assert.equal(input.slice(parsed[1].title.startOffset, parsed[1].title.endOffset), 'B');
});

test('acceptance: getChapterAtOffset maps cursor to chapter', () => {
  const input = 'One.\n\n---\nTitle\nText.\n\n-*- \nSecond\nBody';
  const normalized = input.replace('-*- ', '-*-');
  const parsed = parseChapters(normalized);

  const inFirst = getChapterAtOffset(parsed, 2);
  const inSecond = getChapterAtOffset(parsed, normalized.indexOf('Title'));
  const inThird = getChapterAtOffset(parsed, normalized.indexOf('Second'));

  assert.equal(inFirst.id, parsed[0].id);
  assert.equal(inSecond.id, parsed[1].id);
  assert.equal(inThird.id, parsed[2].id);
});

test('stable chapter ids survive text reflow before chapter', () => {
  const base = 'Intro\n\n---\nMiddle\nBody';
  const edited = 'Intro changed heavily before chapter\n\n---\nMiddle\nBody';

  const baseChapters = parseChapters(base);
  const editedChapters = parseChapters(edited);

  assert.equal(baseChapters[1].id, editedChapters[1].id);
});

test('infers first chapter title from short opening line and blank line', () => {
  const input = 'Prologue\n\nThe room was dark.';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].title);
  assert.equal(parsed[0].title.text, 'Prologue');
});

test('does not infer first chapter title when opening line is too long', () => {
  const input = 'This opening line is intentionally made very long so it should not be treated as a chapter heading at all.\n\nBody';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, undefined);
});

test('infers first chapter title with a single newline after opening line', () => {
  const input = 'Prologue\nBody';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].title);
  assert.equal(parsed[0].title.text, 'Prologue');
});

test('does not infer first chapter title for one-line manuscript', () => {
  const input = 'Prologue';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, undefined);
});
