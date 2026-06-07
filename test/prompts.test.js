const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContinuationPrompt,
  buildContinuationUserMessage,
  buildPremiumContinuationPrompt,
  buildPremiumContinuationUserMessage,
  buildMetaStoryContinuationPrompt,
  buildMetaStoryPremiumContinuationPrompt,
  parsePremiumContinuationResult,
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

test('buildPremiumContinuationPrompt includes evaluation criteria and mode guidance', () => {
  const defaultPrompt = buildPremiumContinuationPrompt('Stay tense', 'default');
  const midPrompt = buildPremiumContinuationPrompt('', 'mid_sentence');
  const paraPrompt = buildPremiumContinuationPrompt('', 'paragraph_start');

  assert.match(defaultPrompt, /PHASE 1/);
  assert.match(defaultPrompt, /PHASE 2/);
  assert.match(defaultPrompt, /Style:/);
  assert.match(defaultPrompt, /Metaphors:/);
  assert.match(defaultPrompt, /Plot progression:/);
  assert.match(defaultPrompt, /Story intent: Stay tense/);
  assert.doesNotMatch(defaultPrompt, /Mode: mid-sentence completion/);
  assert.match(midPrompt, /Mode: mid-sentence completion/);
  assert.match(paraPrompt, /Mode: beginning-of-paragraph continuation/);
});

test('buildPremiumContinuationUserMessage switches shape by mode', () => {
  const defaultMsg = buildPremiumContinuationUserMessage('One.', 'Two.', 'default');
  const midMsg = buildPremiumContinuationUserMessage('One', 'Two', 'mid_sentence');
  const paraMsg = buildPremiumContinuationUserMessage('One', 'Two', 'paragraph_start');

  assert.match(defaultMsg, /three candidate sentences/);
  assert.match(midMsg, /three candidate continuation texts/);
  assert.match(paraMsg, /three candidate opening sentences/);
});

test('buildMetaStoryContinuationPrompt frames the text as a plan for another story', () => {
  const prompt = buildMetaStoryContinuationPrompt('The Tide House', 'default');
  const midPrompt = buildMetaStoryContinuationPrompt('', 'mid_sentence');

  assert.match(prompt, /meta story/);
  assert.match(prompt, /titled "The Tide House"/);
  assert.match(prompt, /NOT the prose manuscript/);
  assert.match(prompt, /story being planned/);
  assert.match(prompt, /exactly one sentence/i);
  assert.match(midPrompt, /Mode: mid-sentence completion/);
});

test('buildMetaStoryPremiumContinuationPrompt keeps the JSON evaluation shape', () => {
  const prompt = buildMetaStoryPremiumContinuationPrompt('The Tide House', 'default');

  assert.match(prompt, /meta story/);
  assert.match(prompt, /titled "The Tide House"/);
  assert.match(prompt, /PHASE 1/);
  assert.match(prompt, /PHASE 2/);
  assert.match(prompt, /"candidates":/);
});

test('parsePremiumContinuationResult picks highest-scoring candidate', () => {
  const json = JSON.stringify({
    candidates: [
      { text: 'Sentence A.', style: 5, metaphors: 3, plot: 4 },
      { text: 'Sentence B.', style: 8, metaphors: 7, plot: 9 },
      { text: 'Sentence C.', style: 6, metaphors: 6, plot: 6 },
    ],
  });
  const result = parsePremiumContinuationResult(json);
  assert.equal(result.sentence, 'Sentence B.');
  assert.equal(result.parsed, true);
  assert.equal(result.score, 24);
});

test('parsePremiumContinuationResult handles non-JSON gracefully', () => {
  const result = parsePremiumContinuationResult('Just a plain sentence.');
  assert.equal(result.sentence, 'Just a plain sentence.');
  assert.equal(result.parsed, false);
});

test('parsePremiumContinuationResult extracts JSON from surrounding text', () => {
  const raw = 'Here is my analysis:\n' + JSON.stringify({
    candidates: [
      { text: 'Winner.', style: 10, metaphors: 10, plot: 10 },
      { text: 'Loser.', style: 1, metaphors: 1, plot: 1 },
      { text: 'Middle.', style: 5, metaphors: 5, plot: 5 },
    ],
  }) + '\nDone.';
  const result = parsePremiumContinuationResult(raw);
  assert.equal(result.sentence, 'Winner.');
  assert.equal(result.parsed, true);
});
