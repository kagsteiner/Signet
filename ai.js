require('dotenv').config({ override: true });

const PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();

const providers = {
  openai:    { model: 'gpt-4o-mini',             envKey: 'OPENAI_API_KEY' },
  anthropic: { model: 'claude-sonnet-4-20250514', envKey: 'ANTHROPIC_API_KEY' },
  deepseek:  { model: 'deepseek-chat',            envKey: 'DEEPSEEK_API_KEY',  baseURL: 'https://api.deepseek.com' },
  mistral:   { model: 'mistral-small-latest',     envKey: 'MISTRAL_API_KEY',   baseURL: 'https://api.mistral.ai/v1' },
};

const config = providers[PROVIDER];
if (!config) {
  throw new Error(`Unknown AI_PROVIDER "${PROVIDER}". Valid: ${Object.keys(providers).join(', ')}`);
}

const apiKey = process.env[config.envKey] || '';

async function chat(systemPrompt, userMessage) {
  if (!apiKey) throw new Error(`${config.envKey} is not set`);
  if (PROVIDER === 'anthropic') return anthropicChat(systemPrompt, userMessage);
  return openaiChat(systemPrompt, userMessage);
}

async function openaiChat(systemPrompt, userMessage) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey,
    ...(config.baseURL && { baseURL: config.baseURL }),
  });
  const res = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  return res.choices[0].message.content.trim();
}

async function anthropicChat(systemPrompt, userMessage) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: config.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  return res.content[0].text.trim();
}

module.exports = { chat, configured: Boolean(apiKey), PROVIDER, model: config.model };
