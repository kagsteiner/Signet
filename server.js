require('dotenv').config({ override: true });
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');
const chapters = require('./public/chapters');

const app = express();
const PORT = process.env.PORT || 3005;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const chapterIndexCache = new Map();

// Base path when behind a subpath (e.g. nginx at /signet/). From env, rewrite middleware, or X-Script-Name header.
function getBasePath(req) {
  const fromEnv = (process.env.BASE_PATH || '').replace(/\/$/, '');
  if (fromEnv) return fromEnv.startsWith('/') ? fromEnv : `/${fromEnv}`;
  const fromRewrite = (req && req.basePathPrefix) || '';
  if (fromRewrite) return fromRewrite;
  const fromHeader = (req && req.get('X-Script-Name')) || '';
  return fromHeader.replace(/\/$/, '');
}

// Trust first proxy (nginx) so X-Forwarded-For is used for rate limiting and client IP
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Allow local direct access via subpath (e.g. http://localhost:3005/signet/app) without nginx path stripping.
const localPrefixAliases = (process.env.LOCAL_PATH_ALIASES || '/signet')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean)
  .map((v) => (v.startsWith('/') ? v : `/${v}`))
  .map((v) => v.replace(/\/$/, ''));

app.use((req, _res, next) => {
  const envBase = (process.env.BASE_PATH || '').trim().replace(/\/$/, '');
  const prefixes = envBase ? [envBase, ...localPrefixAliases] : localPrefixAliases;
  for (const prefix of prefixes) {
    if (!prefix || prefix === '/') continue;
    if (req.url === prefix || req.url.startsWith(`${prefix}/`)) {
      req.basePathPrefix = prefix;
      req.url = req.url.slice(prefix.length) || '/';
      break;
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Rate limiting for access key endpoint ---
const enterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many attempts. Please try again later.',
});

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const sessionId = req.cookies.session;
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.findValidSession(sessionId);
  if (!session) {
    res.clearCookie('session', { path: getBasePath(req) || '/' });
    return res.status(401).json({ error: 'Session expired' });
  }
  req.userId = session.user_id;
  req.sessionId = session.id;
  next();
}

// --- Access key entry ---
app.get('/enter/:accessKey', enterLimiter, (req, res) => {
  const hash = db.hashAccessKey(req.params.accessKey);
  const user = db.findUserByAccessKeyHash(hash);
  if (!user) return res.status(404).send(renderErrorPage('Access key not recognized.'));
  const session = db.createSession(user.id);
  const basePath = getBasePath(req);
  res.cookie('session', session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: db.SESSION_DURATION_MS,
    path: basePath || '/',
  });
  res.redirect(`${basePath}/app`);
});

// --- App page ---
app.get('/app', (req, res) => {
  const sessionId = req.cookies.session;
  if (!sessionId || !db.findValidSession(sessionId)) {
    return res.status(401).send(renderErrorPage('Please use your personal access link to enter.'));
  }
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// --- Auth check ---
app.get('/api/me', requireAuth, (req, res) => {
  const d = db.getDb();
  const user = d.prepare('SELECT id, name FROM users WHERE id = ?').get(req.userId);
  res.json({ user });
});

// --- Story CRUD ---
app.get('/api/stories', requireAuth, (req, res) => {
  const stories = db.getUserStories(req.userId);
  res.json({ stories });
});

app.post('/api/stories', requireAuth, (req, res) => {
  const title = req.body.title || 'Untitled';
  const existingStories = db.getUserStories(req.userId);
  const isFirstStory = existingStories.length === 0;
  const story = db.createStory(req.userId, title, {
    initialContent: isFirstStory ? db.FIRST_STORY_STARTER_MANUSCRIPT : '',
  });
  res.json({ story: buildStoryResponse(story) });
});

app.get('/api/stories/:id', requireAuth, (req, res) => {
  const story = db.getStory(req.params.id, req.userId);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  res.json({ story: buildStoryResponse(story) });
});

app.put('/api/stories/:id', requireAuth, (req, res) => {
  const story = db.updateStory(req.params.id, req.userId, req.body);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  chapterIndexCache.delete(story.id);
  res.json({ story: buildStoryResponse(story) });
});

app.delete('/api/stories/:id', requireAuth, (req, res) => {
  const result = db.deleteStory(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Story not found' });
  chapterIndexCache.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/stories/:id/chapter-context', requireAuth, (req, res) => {
  const story = db.getStory(req.params.id, req.userId);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  const parsedOffset = Number(req.query.offset);
  if (!Number.isFinite(parsedOffset)) {
    return res.status(400).json({ error: 'offset query parameter is required' });
  }

  const chapterData = getCachedChapterData(story);
  const context = chapters.getChapterContext(chapterData.chapters, parsedOffset);
  res.json({
    current: context.current,
    before: context.before,
    after: context.after,
  });
});

// --- AI Continuation (The Gem) ---
app.post('/api/continue', requireAuth, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'AI not configured' });
  const { precedingText, storyIntent } = req.body;
  if (!precedingText) return res.status(400).json({ error: 'No text provided' });

  try {
    const systemPrompt = buildContinuationPrompt(storyIntent);
    const result = await callOpenAI(systemPrompt, precedingText);
    res.json({ sentence: result });
  } catch (err) {
    console.error('Continuation error:', err);
    res.status(500).json({ error: 'Failed to generate continuation' });
  }
});

// --- AI Rewrite ---
app.post('/api/rewrite', requireAuth, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'AI not configured' });
  const { selectedText, instruction, fullText, selectionStart, selectionEnd } = req.body;
  if (!selectedText || !instruction) return res.status(400).json({ error: 'Missing text or instruction' });

  try {
    const selectedHasOuterQuotes = hasOuterMatchingQuotes(selectedText);
    const rewriteContext = buildRewriteContext(fullText, selectionStart, selectionEnd, selectedText);
    const result = await callRewrite(selectedText, instruction, rewriteContext, selectedHasOuterQuotes);
    res.json({ rewritten: result });
  } catch (err) {
    console.error('Rewrite error:', err);
    res.status(500).json({ error: 'Failed to rewrite' });
  }
});

// --- Root redirect ---
app.get('/', (req, res) => {
  const sessionId = req.cookies.session;
  if (sessionId && db.findValidSession(sessionId)) {
    return res.redirect(`${getBasePath(req)}/app`);
  }
  res.send(renderErrorPage('Signet is invitation-only. Please use your personal access link.'));
});

// --- AI helpers ---

function buildContinuationPrompt(storyIntent) {
  let prompt = `You are a literary ghost writer. You write exactly one sentence to continue the narrative.

Rules:
- Output ONLY the continuation sentence. Nothing else.
- Exactly one complete sentence, ending with appropriate punctuation.
- Maximum 25-30 words.
- Match the tense, POV, and tone of the preceding text.
- Avoid clichés, exposition dumps, meta commentary, and summarizing.
- The sentence must feel like a natural next beat in the story.
- Never explain yourself. Never add quotes or attribution to your output.`;

  if (storyIntent) prompt += `\n\nStory intent (private, for context only): ${storyIntent}`;
  return prompt;
}

async function callOpenAI(systemPrompt, userContent) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: 'gpt-5.2',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Continue this text with exactly one sentence:\n\n${userContent}` },
    ]
  });
  return response.choices[0].message.content.trim();
}

function hasOuterMatchingQuotes(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const pairs = new Map([
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]);
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return pairs.has(first) && pairs.get(first) === last;
}

function stripOneOuterQuotePair(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const pairs = new Map([
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]);
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (pairs.has(first) && pairs.get(first) === last) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeRewriteResult(rawResult, selectedHasOuterQuotes) {
  let result = typeof rawResult === 'string' ? rawResult.trim() : '';
  if (!result) return result;
  if (!selectedHasOuterQuotes) {
    // Some models still wrap output in quotes even when instructed not to.
    result = stripOneOuterQuotePair(result);
  }
  return result;
}

function buildRewriteContext(fullText, startRaw, endRaw, selectedText) {
  if (typeof fullText !== 'string') return null;
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const safeStart = Math.max(0, Math.min(start, end, fullText.length));
  const safeEnd = Math.max(0, Math.min(Math.max(start, end), fullText.length));
  if (safeStart === safeEnd) return null;
  if (fullText.slice(safeStart, safeEnd) !== selectedText) return null;

  const breakRegex = /\n\s*\n/g;
  const paragraphs = [];
  let paraStart = 0;
  let match = breakRegex.exec(fullText);
  while (match) {
    paragraphs.push({ start: paraStart, end: match.index });
    paraStart = match.index + match[0].length;
    match = breakRegex.exec(fullText);
  }
  paragraphs.push({ start: paraStart, end: fullText.length });

  const overlapping = paragraphs.filter((paragraph) => paragraph.end > safeStart && paragraph.start < safeEnd);
  if (overlapping.length === 0) return null;

  const contextStart = overlapping[0].start;
  const contextEnd = overlapping[overlapping.length - 1].end;
  const contextText = fullText.slice(contextStart, contextEnd);
  const relStart = safeStart - contextStart;
  const relEnd = safeEnd - contextStart;
  const marked =
    contextText.slice(0, relStart) +
    '[[selection]]' +
    contextText.slice(relStart, relEnd) +
    '[[/selection]]' +
    contextText.slice(relEnd);

  return {
    contextParagraphsWithSelection: marked,
    selectedText,
  };
}

async function callRewrite(selectedText, instruction, rewriteContext, selectedHasOuterQuotes) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  let userMsg = `Instruction: ${instruction}`;
  if (rewriteContext && rewriteContext.contextParagraphsWithSelection) {
    userMsg += `\n\nBelow are the full paragraph(s) containing the selected text. The selected span is marked with [[selection]]...[[/selection]].\n\n${rewriteContext.contextParagraphsWithSelection}`;
  } else {
    userMsg += `\n\nSelected span:\n[[selection]]${selectedText}[[/selection]]`;
  }
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a literary editor.
Your task:
1) Identify the exact text between [[selection]] and [[/selection]].
2) Rewrite ONLY that selected text based on the instruction.
3) Keep it consistent with the paragraph context.

Output rules:
- Return ONLY the rewritten replacement text for the selected span.
- Do NOT return full paragraphs, markers, labels, or explanations.
- Do NOT add surrounding quotation marks unless the original selected text is itself surrounded by matching quotation marks.
- Do not include backticks.`,
      },
      { role: 'user', content: userMsg },
    ],
    max_tokens: 200,
    temperature: 0.7,
  });
  const raw = response.choices[0].message.content || '';
  return normalizeRewriteResult(raw, selectedHasOuterQuotes);
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signet</title>
  <style>
    body {
      font-family: 'Iowan Old Style', 'Palatino Linotype', 'Palatino', Georgia, serif;
      background: #faf6f0;
      color: #3d3229;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .msg {
      text-align: center;
      max-width: 400px;
      line-height: 1.7;
      font-size: 1.1rem;
    }
  </style>
</head>
<body><div class="msg">${message}</div></body>
</html>`;
}

function getCachedChapterData(story) {
  const cached = chapterIndexCache.get(story.id);
  if (cached && cached.lastModified === story.last_modified && cached.content === story.content_markdown) {
    return cached;
  }

  const parsed = {
    content: story.content_markdown || '',
    chapters: chapters.parseChapters(story.content_markdown || ''),
    lastModified: story.last_modified,
  };
  chapterIndexCache.set(story.id, parsed);
  return parsed;
}

function buildStoryResponse(story) {
  const chapterData = getCachedChapterData(story);
  return {
    ...story,
    chapters: chapterData.chapters,
  };
}

// Periodic cleanup
setInterval(() => db.cleanExpiredSessions(), 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Signet running on port ${PORT}`);
});
