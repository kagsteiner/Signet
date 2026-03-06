#!/usr/bin/env node
const fs = require('fs');

const [startFile, intentFile, provider, outputFile] = process.argv.slice(2);
if (!startFile || !provider) {
  console.error('Usage: node modeltest.js <start-file> <intent-file> <provider> [output-file]');
  console.error('  provider: openai | anthropic | deepseek | mistral');
  process.exit(1);
}
const startText = fs.readFileSync(startFile, 'utf8').trim();
const storyIntent = fs.existsSync(intentFile) ? fs.readFileSync(intentFile, 'utf8').trim() : '';

require('dotenv').config({ override: true });
process.env.AI_PROVIDER = provider;

const ai = require('./ai');
const prompts = require('./prompts');

const ITERATIONS = 10;

async function run() {
  console.log(`Provider: ${ai.PROVIDER}  Model: ${ai.model}`);
  console.log(`Story intent: ${storyIntent || '(none)'}`);
  console.log(`Start text:\n${startText}\n`);

  let text = startText;
  const systemPrompt = prompts.buildContinuationPrompt(storyIntent || '', 'default');

  for (let i = 1; i <= ITERATIONS; i++) {
    const userMessage = prompts.buildContinuationUserMessage(text, null, 'default');
    const sentence = await ai.chat(systemPrompt, userMessage);
    text += ' ' + sentence;
    console.log(`[${i}/${ITERATIONS}] ${sentence}`);
  }

  const outName = outputFile || 'modeloutput.txt';
  fs.writeFileSync(outName, text, 'utf8');
  console.log(`\nWritten to ${outName} (${text.length} chars)`);
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
