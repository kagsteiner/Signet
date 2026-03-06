require('dotenv').config({ override: true });
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');
const chapters = require('./public/chapters');
const ai = require('./ai');
const prompts = require('./prompts');

const app = express();
const PORT = process.env.PORT || 3005;
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
  req.userTier = db.getUserTier(session.user_id);
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
  const existingStories = db.getUserStories(req.userId);
  const isFirstStory = existingStories.length === 0;
  const story = db.createStory(req.userId, {
    title: typeof req.body.title === 'string' ? req.body.title : '',
    author: typeof req.body.author === 'string' ? req.body.author : '',
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
  if (!ai.configured) return res.status(500).json({ error: 'AI not configured' });
  const { precedingText, followingText, storyIntent, mode } = req.body;
  if (!precedingText) return res.status(400).json({ error: 'No text provided' });

  try {
    const systemPrompt = prompts.buildContinuationPrompt(storyIntent, mode);
    const userContent = prompts.buildContinuationUserMessage(precedingText, followingText, mode);
    const result = await ai.chat(systemPrompt, userContent, req.userTier, req.userId);
    res.json({ sentence: result });
  } catch (err) {
    console.error('Continuation error:', err);
    res.status(500).json({ error: 'Failed to generate continuation' });
  }
});

// --- AI Rewrite ---
app.post('/api/rewrite', requireAuth, async (req, res) => {
  if (!ai.configured) return res.status(500).json({ error: 'AI not configured' });
  const { selectedText, instruction, fullText, selectionStart, selectionEnd, storyIntent } = req.body;
  if (!selectedText || !instruction) return res.status(400).json({ error: 'Missing text or instruction' });

  try {
    const selectedHasOuterQuotes = hasOuterMatchingQuotes(selectedText);
    const rewriteContext = buildRewriteContext(fullText, selectionStart, selectionEnd, selectedText);
    const { systemPrompt, userMessage } = buildRewriteMessages(
      selectedText, instruction, rewriteContext, storyIntent
    );
    const raw = await ai.chat(systemPrompt, userMessage, req.userTier, req.userId);
    const result = normalizeRewriteResult(raw, selectedHasOuterQuotes);
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

  const chapterList = chapters.parseChapters(fullText);
  const containingChapter = chapters.getChapterAtOffset(chapterList, safeStart);
  if (!containingChapter) return null;

  const contextStart = containingChapter.startOffset;
  const contextEnd = containingChapter.endOffset;
  if (safeStart < contextStart || safeEnd > contextEnd) return null;

  const contextText = fullText.slice(contextStart, contextEnd);
  const relStart = safeStart - contextStart;
  const relEnd = safeEnd - contextStart;
  const marked =
    contextText.slice(0, relStart) +
    '<replace>' +
    contextText.slice(relStart, relEnd) +
    '</replace>' +
    contextText.slice(relEnd);

  return {
    contextChapterWithSelection: marked,
    chapterTitle: containingChapter.title && containingChapter.title.text
      ? containingChapter.title.text
      : null,
    selectedText,
  };
}

function buildRewriteMessages(selectedText, instruction, rewriteContext, storyIntentRaw) {
  const storyIntent = typeof storyIntentRaw === 'string' ? storyIntentRaw.trim() : '';
  const systemPrompt = `You are a literary editor.
Your task:
1) Identify the exact text between <replace> and </replace>.
2) Rewrite ONLY that selected text based on the instruction. Follow the instruction exactly.
3) Keep it consistent with the chapter context and story intent (if provided).

Output rules:
- Return ONLY the rewritten replacement text for the selected span.
- Do NOT return full paragraphs, markers, labels, or explanations.
- Do NOT add surrounding quotation marks unless the original selected text is itself surrounded by matching quotation marks.
- Do not include backticks.`;

  let userMessage = `Instruction: ${instruction}`;
  if (storyIntent) {
    userMessage += `\n\nStory intent (directional guidance):\n${storyIntent}`;
  }
  if (rewriteContext && rewriteContext.contextChapterWithSelection) {
    userMessage += `\n\nBelow is the full chapter containing the selected text.`;
    if (rewriteContext.chapterTitle) {
      userMessage += `\nChapter title: ${rewriteContext.chapterTitle}`;
    }
    userMessage += `\nThe selected span is wrapped with <replace>...</replace>.\n\n${rewriteContext.contextChapterWithSelection}`;
  } else {
    userMessage += `\n\nSelected span:\n<replace>${selectedText}</replace>`;
  }
  return { systemPrompt, userMessage };
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
