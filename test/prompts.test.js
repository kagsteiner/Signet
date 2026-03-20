const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContinuationPrompt,
  buildContinuationUserMessage,
  buildRecallPrompt,
  buildRecallUserMessage,
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

test('buildRecallPrompt keeps recall extractive and quiet', () => {
  const prompt = buildRecallPrompt('Do not reveal the ending.');

  assert.match(prompt, /very short reminder of its narrative meaning/);
  assert.match(prompt, /If the reference is unclear, return NOTHING/);
  assert.match(prompt, /Story intent \(directional guidance only, not established fact\)/);
});

test('buildRecallUserMessage includes marked chapter context and neighbors', () => {
  const message = buildRecallUserMessage('John', {
    chapterTitle: 'Harbor',
    previousChapterTitle: 'Before Dawn',
    nextChapterTitle: 'Ashes',
    contextChapterWithSelection: 'John waited by the dock.\nThe bells would not stop.',
  });

  assert.match(message, /Selected word: John/);
  assert.match(message, /Chapter title: Harbor/);
  assert.match(message, /Previous chapter: Before Dawn/);
  assert.match(message, /Next chapter: Ashes/);
  assert.match(message, /wrapped with <recall>...<\/recall>/);
});
