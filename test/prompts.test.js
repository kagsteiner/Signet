const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContinuationPrompt,
  buildContinuationUserMessage,
} = require('../prompts');

test('buildContinuationPrompt includes mode-specific guidance', () => {
  const defaultPrompt = buildContinuationPrompt('Stay restrained', 'default');
  const midSentencePrompt = buildContinuationPrompt('', 'mid_sentence');
  const paragraphStartPrompt = buildContinuationPrompt('', 'paragraph_start');

  assert.match(defaultPrompt, /Story intent: Stay restrained/);
  assert.doesNotMatch(defaultPrompt, /Mode: mid-sentence completion/);
  assert.match(midSentencePrompt, /Mode: mid-sentence completion/);
  assert.match(midSentencePrompt, /Output only the missing continuation text/);
  assert.match(paragraphStartPrompt, /Mode: beginning-of-paragraph continuation/);
});

test('buildContinuationUserMessage switches shape by mode', () => {
  const defaultMessage = buildContinuationUserMessage('One.', 'Two.', 'default');
  const midSentenceMessage = buildContinuationUserMessage('One', 'Two', 'mid_sentence');
  const paragraphStartMessage = buildContinuationUserMessage('One', 'Two', 'paragraph_start');

  assert.equal(defaultMessage, 'Continue this text with exactly one sentence:\n\nOne.');
  assert.match(midSentenceMessage, /Write the exact continuation text to insert at the cursor/);
  assert.match(paragraphStartMessage, /Write one opening sentence for the new paragraph at the cursor/);
});
