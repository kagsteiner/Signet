let logLlm = process.env.LOG_LLM !== '0';

const providers = {
  deepseek:  { model: 'deepseek-chat',        envKey: 'DEEPSEEK_API_KEY',  baseURL: 'https://api.deepseek.com' },
  anthropic: { model: 'claude-sonnet-4-6',   envKey: 'ANTHROPIC_API_KEY' },
  openai:    { model: 'gpt-5.4',              envKey: 'OPENAI_API_KEY' },
  openaiMini: { model: 'gpt-5.4-mini',        envKey: 'OPENAI_API_KEY' },
  mistral:   { model: 'mistral-large-latest',  envKey: 'MISTRAL_API_KEY',   baseURL: 'https://api.mistral.ai/v1' },
};

const tierToProvider = {
  common: 'deepseek',
  bronze: 'deepseek',
  silver: 'deepseek',
  gold:   'anthropic',
  platinum: 'anthropic',
};

function getProviderForTier(tier) {
  return tierToProvider[tier] || tierToProvider.common;
}

function getApiKey(providerName) {
  const cfg = providers[providerName];
  return cfg ? (process.env[cfg.envKey] || '') : '';
}

async function chat(systemPrompt, userMessage, tier, user) {
  const providerName = getProviderForTier(tier);
  const config = providers[providerName];
  const apiKey = getApiKey(providerName);
  if (!apiKey) throw new Error(`${config.envKey} is not set (needed for tier "${tier}")`);
  if (logLlm) console.log(`[LLM] user=${user || '?'} tier=${tier} provider=${providerName} model=${config.model}`);
  if (providerName === 'anthropic') return anthropicChat(config, apiKey, systemPrompt, userMessage);
  return openaiChat(config, apiKey, systemPrompt, userMessage);
}

async function openaiChat(config, apiKey, systemPrompt, userMessage) {
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

async function anthropicChat(config, apiKey, systemPrompt, userMessage) {
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

async function chatWithProvider(systemPrompt, userMessage, providerName, user) {
  const config = providers[providerName];
  if (!config) throw new Error(`Unknown provider "${providerName}". Valid: ${Object.keys(providers).join(', ')}`);
  const apiKey = getApiKey(providerName);
  if (!apiKey) throw new Error(`${config.envKey} is not set`);
  if (logLlm) console.log(`[LLM] user=${user || '?'} tier=- provider=${providerName} model=${config.model}`);
  if (providerName === 'anthropic') return anthropicChat(config, apiKey, systemPrompt, userMessage);
  return openaiChat(config, apiKey, systemPrompt, userMessage);
}

const configured = Boolean(getApiKey('deepseek')) || Boolean(getApiKey('anthropic')) || Boolean(getApiKey('openai'));

function setLogLlm(enabled) { logLlm = enabled; }

module.exports = { chat, chatWithProvider, configured, providers, tierToProvider, getProviderForTier, setLogLlm };
