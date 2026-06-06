const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseChapters,
  getChapterContext,
} = require('../public/chapters');

test('acceptance: unicode dash divider normalizes to chapter separator', () => {
  const input = 'Intro\n\n—\nChapter\nBody';
  const parsed = parseChapters(input);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].dividerStyle, '---');
  assert.equal(parsed[1].title.text, 'Chapter');
});

test('acceptance: empty manuscript still yields one empty chapter', () => {
  const parsed = parseChapters('');

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].startOffset, 0);
  assert.equal(parsed[0].endOffset, 0);
  assert.equal(parsed[0].title, undefined);
});

test('acceptance: getChapterContext returns before and after chapters', () => {
  const input = 'Intro\n\n---\nMiddle\nBody\n\n---\nEnd\nDone';
  const parsed = parseChapters(input);
  const context = getChapterContext(parsed, input.indexOf('Body'));

  assert.equal(context.current.title.text, 'Middle');
  assert.equal(context.before.length, 1);
  assert.equal(context.after.length, 1);
  assert.equal(context.before[0].title.text, 'Intro');
  assert.equal(context.after[0].title.text, 'End');
});
