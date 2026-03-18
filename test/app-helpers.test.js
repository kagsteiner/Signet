const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getBasePath,
  hasOuterMatchingQuotes,
  stripOneOuterQuotePair,
  normalizeRewriteResult,
  buildRewriteContext,
  buildRewriteMessages,
} = require('../server/app-helpers');

test('getBasePath prefers BASE_PATH from env', () => {
  const actual = getBasePath(
    { basePathPrefix: '/from-rewrite', get: () => '/from-header' },
    { BASE_PATH: 'signet/' }
  );

  assert.equal(actual, '/signet');
});

test('getBasePath falls back to rewrite prefix and header', () => {
  const fromRewrite = getBasePath({ basePathPrefix: '/rewritten', get: () => '/ignored/' }, {});
  const fromHeader = getBasePath({ get: () => '/header-path/' }, {});

  assert.equal(fromRewrite, '/rewritten');
  assert.equal(fromHeader, '/header-path');
});

test('quote helpers recognize and normalize wrapped text', () => {
  assert.equal(hasOuterMatchingQuotes('“Hello.”'), true);
  assert.equal(hasOuterMatchingQuotes('Hello.'), false);
  assert.equal(stripOneOuterQuotePair(' "Hello." '), 'Hello.');
  assert.equal(normalizeRewriteResult(' "Hello." ', false), 'Hello.');
  assert.equal(normalizeRewriteResult(' "Hello." ', true), '"Hello."');
});

test('buildRewriteContext returns marked current chapter for valid selection', () => {
  const fullText = 'Intro line\n\n---\nChapter One\nAlpha beta gamma';
  const selectedText = 'beta';
  const start = fullText.indexOf(selectedText);
  const end = start + selectedText.length;

  const context = buildRewriteContext(fullText, start, end, selectedText);

  assert.deepEqual(context, {
    chapterTitle: 'Chapter One',
    contextChapterWithSelection: 'Chapter One\nAlpha <replace>beta</replace> gamma',
    selectedText: 'beta',
  });
});

test('buildRewriteContext rejects cross-chapter and mismatched selections', () => {
  const fullText = 'First\n\n---\nSecond';

  assert.equal(buildRewriteContext(fullText, 0, 1000, 'First'), null);
  assert.equal(buildRewriteContext(fullText, 0, 5, 'Wrong'), null);

  const start = fullText.indexOf('First');
  const end = fullText.indexOf('Second') + 'Second'.length;
  assert.equal(buildRewriteContext(fullText, start, end, fullText.slice(start, end)), null);
});

test('buildRewriteMessages includes story intent and chapter title when available', () => {
  const messages = buildRewriteMessages(
    'beta',
    'make it quieter',
    {
      chapterTitle: 'Chapter One',
      contextChapterWithSelection: 'Alpha <replace>beta</replace> gamma',
    },
    'Keep it understated'
  );

  assert.match(messages.systemPrompt, /Return ONLY the rewritten replacement text/);
  assert.match(messages.userMessage, /Instruction: make it quieter/);
  assert.match(messages.userMessage, /Story intent \(directional guidance\):/);
  assert.match(messages.userMessage, /Chapter title: Chapter One/);
  assert.match(messages.userMessage, /<replace>beta<\/replace>/);
});
