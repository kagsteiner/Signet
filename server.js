require('dotenv').config({ override: true });
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');
const chapters = require('./public/chapters');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const chapterIndexCache = new Map();

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
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
    res.clearCookie('session');
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
  res.cookie('session', session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: db.SESSION_DURATION_MS,
    path: '/',
  });
  res.redirect('/app');
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
  const { selectedText, instruction, surroundingContext } = req.body;
  if (!selectedText || !instruction) return res.status(400).json({ error: 'Missing text or instruction' });

  try {
    const result = await callRewrite(selectedText, instruction, surroundingContext);
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
    return res.redirect('/app');
  }
  res.send(renderErrorPage('Storytellers is invitation-only. Please use your personal access link.'));
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

async function callRewrite(selectedText, instruction, surroundingContext) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  let userMsg = `Selected text to transform:\n"${selectedText}"\n\nInstruction: ${instruction}`;
  if (surroundingContext) userMsg += `\n\nSurrounding context for tone/style reference:\n${surroundingContext}`;
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a literary editor. Transform the selected text according to the user's instruction. Output ONLY the transformed text. No explanations, no quotes around the output, no commentary.`,
      },
      { role: 'user', content: userMsg },
    ],
    max_tokens: 200,
    temperature: 0.7,
  });
  return response.choices[0].message.content.trim();
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storytellers</title>
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
  console.log(`Storytellers 2 running on port ${PORT}`);
});
