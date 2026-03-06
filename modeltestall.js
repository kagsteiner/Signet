#!/usr/bin/env node
const { execSync } = require('child_process');

const [startFile, intentFile] = process.argv.slice(2);
if (!startFile || !intentFile) {
  console.error('Usage: node modeltestall.js <start-file> <intent-file>');
  process.exit(1);
}

const providers = ['openai', 'anthropic', 'deepseek', 'mistral'];

for (const provider of providers) {
  const outFile = `modeloutput_${provider}.txt`;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${provider.toUpperCase()}`);
  console.log(`${'='.repeat(60)}\n`);
  try {
    execSync(`node modeltest.js "${startFile}" "${intentFile}" ${provider} ${outFile}`, {
      stdio: 'inherit',
    });
  } catch {
    console.error(`\n** ${provider} failed, skipping **\n`);
  }
}
