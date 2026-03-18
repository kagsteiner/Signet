const test = require('node:test');
const assert = require('node:assert/strict');

const { createTempDb } = require('../test-support/temp-db');
const { startTestServer, createAuthState } = require('../test-support/server');

async function requestJson(origin, pathname, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(`${origin}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: options.redirect || 'follow',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { res, json };
}

test('api requires auth for protected routes', async (t) => {
  const fixture = createTempDb();
  const server = await startTestServer({ db: fixture.db });
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const res = await fetch(`${server.origin}/api/me`, { redirect: 'manual' });

  assert.equal(res.status, 401);
});

test('story CRUD and chapter-context endpoints work with isolated db', async (t) => {
  const fixture = createTempDb({ now: 1000 });
  const server = await startTestServer({ db: fixture.db });
  const auth = createAuthState(fixture.db, 'Api User');
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const created = await requestJson(server.origin, '/api/stories', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: { title: 'My Story' },
  });
  assert.equal(created.res.status, 200);
  assert.equal(created.json.story.title, 'My Story');

  const storyId = created.json.story.id;
  const updatedText = 'Intro\n\n---\nFirst Chapter\nBody';
  const updated = await requestJson(server.origin, `/api/stories/${storyId}`, {
    method: 'PUT',
    headers: { Cookie: auth.cookie },
    body: { content_markdown: updatedText },
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.json.story.chapters.length, 2);
  assert.equal(updated.json.story.chapters[1].title.text, 'First Chapter');

  const offset = updatedText.indexOf('Body');
  const chapterContext = await requestJson(
    server.origin,
    `/api/stories/${storyId}/chapter-context?offset=${offset}`,
    { headers: { Cookie: auth.cookie } }
  );
  assert.equal(chapterContext.res.status, 200);
  assert.equal(chapterContext.json.current.title.text, 'First Chapter');

  const secondText = 'Opening\n\n---\nChanged Chapter\nDifferent body';
  const refreshed = await requestJson(server.origin, `/api/stories/${storyId}`, {
    method: 'PUT',
    headers: { Cookie: auth.cookie },
    body: { content_markdown: secondText },
  });
  assert.equal(refreshed.json.story.chapters[1].title.text, 'Changed Chapter');

  const deleted = await requestJson(server.origin, `/api/stories/${storyId}`, {
    method: 'DELETE',
    headers: { Cookie: auth.cookie },
  });
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.json.ok, true);
});

test('continue endpoint uses injected AI and prompt builders', async (t) => {
  const fixture = createTempDb();
  const calls = [];
  const ai = {
    configured: true,
    async chat(systemPrompt, userMessage, tier, userId) {
      calls.push({ systemPrompt, userMessage, tier, userId });
      return 'The lantern trembled in her hand.';
    },
  };
  const server = await startTestServer({ db: fixture.db, ai });
  const auth = createAuthState(fixture.db, 'Continue User');
  fixture.db.setUserTier(auth.user.id, 'gold');
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const response = await requestJson(server.origin, '/api/continue', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: {
      precedingText: 'Night settled over the lane.',
      followingText: '',
      storyIntent: 'Keep the tone tense.',
      mode: 'paragraph_start',
    },
  });

  assert.equal(response.res.status, 200);
  assert.equal(response.json.sentence, 'The lantern trembled in her hand.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tier, 'gold');
  assert.match(calls[0].systemPrompt, /beginning-of-paragraph continuation/);
  assert.match(calls[0].userMessage, /Text before cursor:/);
});

test('rewrite endpoint normalizes quoted AI output', async (t) => {
  const fixture = createTempDb();
  const ai = {
    configured: true,
    async chat() {
      return ' "Quiet replacement." ';
    },
  };
  const server = await startTestServer({ db: fixture.db, ai });
  const auth = createAuthState(fixture.db, 'Rewrite User');
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const fullText = 'Intro\n\n---\nChapter\nAlpha beta gamma';
  const selectedText = 'beta';
  const start = fullText.indexOf(selectedText);
  const end = start + selectedText.length;
  const response = await requestJson(server.origin, '/api/rewrite', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: {
      fullText,
      selectedText,
      instruction: 'Make it quieter',
      selectionStart: start,
      selectionEnd: end,
      storyIntent: 'Keep it literary',
    },
  });

  assert.equal(response.res.status, 200);
  assert.equal(response.json.rewritten, 'Quiet replacement.');
});
