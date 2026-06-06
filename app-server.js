const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const defaultDb = require('./db');
const chapters = require('./public/chapters');
const defaultAi = require('./ai');
const defaultPrompts = require('./prompts');
const {
  getBasePath,
  hasOuterMatchingQuotes,
  normalizeRewriteResult,
  buildRewriteContext,
  buildRewriteMessages,
  buildRecallContext,
  normalizeRecallResult,
} = require('./server/app-helpers');

const DEBUG_PREMIUM_CONTINUATION = false;

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

function createApp(options = {}) {
  const db = options.db || defaultDb;
  const ai = options.ai || defaultAi;
  const prompts = options.prompts || defaultPrompts;
  const env = options.env || process.env;
  const staticDir = options.staticDir || path.join(__dirname, 'public');
  const enableCleanupTimer = options.enableCleanupTimer !== false;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;

  const app = express();
  const chapterIndexCache = new Map();

  function buildResolvedBasePath(req) {
    return getBasePath(req, env);
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

  // Trust first proxy (nginx) so X-Forwarded-For is used for rate limiting and client IP.
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // Allow local direct access via subpath (e.g. http://localhost:3005/signet/app) without nginx path stripping.
  const localPrefixAliases = (env.LOCAL_PATH_ALIASES || '/signet')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith('/') ? v : `/${v}`))
    .map((v) => v.replace(/\/$/, ''));

  app.use((req, _res, next) => {
    const envBase = (env.BASE_PATH || '').trim().replace(/\/$/, '');
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

  app.use(express.static(staticDir));

  const enterLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many attempts. Please try again later.',
  });

  function requireAuth(req, res, next) {
    const sessionId = req.cookies.session;
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
    const session = db.findValidSession(sessionId);
    if (!session) {
      res.clearCookie('session', { path: buildResolvedBasePath(req) || '/' });
      return res.status(401).json({ error: 'Session expired' });
    }
    req.userId = session.user_id;
    req.sessionId = session.id;
    req.userTier = db.getUserTier(session.user_id);
    next();
  }

  app.get('/enter/:accessKey', enterLimiter, (req, res) => {
    const hash = db.hashAccessKey(req.params.accessKey);
    const user = db.findUserByAccessKeyHash(hash);
    if (!user) return res.status(404).send(renderErrorPage('Access key not recognized.'));
    const session = db.createSession(user.id);
    const basePath = buildResolvedBasePath(req);
    res.cookie('session', session.id, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: db.SESSION_DURATION_MS,
      path: basePath || '/',
    });
    res.redirect(`${basePath}/app`);
  });

  app.get('/app', (req, res) => {
    const sessionId = req.cookies.session;
    if (!sessionId || !db.findValidSession(sessionId)) {
      return res.status(401).send(renderErrorPage('Please use your personal access link to enter.'));
    }
    res.sendFile(path.join(staticDir, 'app.html'));
  });

  app.get('/api/me', requireAuth, (req, res) => {
    const d = db.getDb();
    const user = d.prepare('SELECT id, name FROM users WHERE id = ?').get(req.userId);
    res.json({ user });
  });

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

  app.post('/api/continue-premium', requireAuth, async (req, res) => {
    if (!ai.configured) return res.status(500).json({ error: 'AI not configured' });
    const { precedingText, followingText, storyIntent, mode } = req.body;
    if (!precedingText) return res.status(400).json({ error: 'No text provided' });

    try {
      const systemPrompt = prompts.buildPremiumContinuationPrompt(storyIntent, mode);
      const userContent = prompts.buildPremiumContinuationUserMessage(precedingText, followingText, mode);
      if (DEBUG_PREMIUM_CONTINUATION) {
        console.log('\n=== PREMIUM CONTINUATION — SYSTEM PROMPT ===\n' + systemPrompt);
        console.log('\n=== PREMIUM CONTINUATION — USER MESSAGE ===\n' + userContent);
      }
      const raw = await ai.chatPremium(systemPrompt, userContent, req.userTier, req.userId);
      const parsed = prompts.parsePremiumContinuationResult(raw);
      if (DEBUG_PREMIUM_CONTINUATION) {
        console.log('\n=== PREMIUM CONTINUATION — RAW LLM RESPONSE ===\n' + raw);
        console.log('\n=== PREMIUM CONTINUATION — SELECTED SENTENCE (score ' + (parsed.score ?? 'n/a') + ') ===\n' + parsed.sentence + '\n');
      }
      res.json({ sentence: parsed.sentence });
    } catch (err) {
      console.error('Premium continuation error:', err);
      res.status(500).json({ error: 'Failed to generate premium continuation' });
    }
  });

  app.post('/api/rewrite', requireAuth, async (req, res) => {
    if (!ai.configured) return res.status(500).json({ error: 'AI not configured' });
    const { selectedText, instruction, fullText, selectionStart, selectionEnd, storyIntent } = req.body;
    if (!selectedText || !instruction) return res.status(400).json({ error: 'Missing text or instruction' });

    try {
      const selectedHasOuterQuotes = hasOuterMatchingQuotes(selectedText);
      const rewriteContext = buildRewriteContext(fullText, selectionStart, selectionEnd, selectedText);
      const { systemPrompt, userMessage } = buildRewriteMessages(
        selectedText,
        instruction,
        rewriteContext,
        storyIntent
      );
      const raw = await ai.chat(systemPrompt, userMessage, req.userTier, req.userId);
      const result = normalizeRewriteResult(raw, selectedHasOuterQuotes);
      res.json({ rewritten: result });
    } catch (err) {
      console.error('Rewrite error:', err);
      res.status(500).json({ error: 'Failed to rewrite' });
    }
  });

  app.post('/api/recall', requireAuth, async (req, res) => {
    if (!ai.configured) return res.status(500).json({ error: 'AI not configured' });
    const {
      selectedText,
      fullText,
      selectionStart,
      selectionEnd,
      storyIntent,
    } = req.body;
    if (!selectedText) return res.status(400).json({ error: 'Missing selected text' });

    try {
      const recallContext = buildRecallContext(fullText, selectionStart, selectionEnd, selectedText);
      if (!recallContext) {
        return res.status(400).json({ error: 'Invalid recall selection' });
      }

      const systemPrompt = prompts.buildRecallPrompt(storyIntent);
      const userMessage = prompts.buildRecallUserMessage(selectedText, recallContext);
      const rawResult = typeof ai.chatWithProvider === 'function'
        ? await ai.chatWithProvider(systemPrompt, userMessage, 'openaiMini', req.userId)
        : await ai.chat(systemPrompt, userMessage, req.userTier, req.userId);
      const recall = normalizeRecallResult(rawResult);
      res.json({ recall: recall || null });
    } catch (err) {
      console.error('Recall error:', err);
      res.status(500).json({ error: 'Failed to generate recall' });
    }
  });

  app.get('/', (req, res) => {
    const sessionId = req.cookies.session;
    if (sessionId && db.findValidSession(sessionId)) {
      return res.redirect(`${buildResolvedBasePath(req)}/app`);
    }
    res.send(renderErrorPage('Signet is invitation-only. Please use your personal access link.'));
  });

  const cleanupTimer = enableCleanupTimer
    ? setIntervalFn(() => db.cleanExpiredSessions(), 60 * 60 * 1000)
    : null;

  app.locals.signet = {
    dispose() {
      if (cleanupTimer) clearIntervalFn(cleanupTimer);
    },
    chapterIndexCache,
  };

  return app;
}

module.exports = {
  createApp,
};
