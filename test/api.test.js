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

test('/enter/:accessKey sets session cookie for valid key', async (t) => {
  const fixture = createTempDb();
  const server = await startTestServer({ db: fixture.db });
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const user = fixture.db.createUser('Enter User');
  const res = await fetch(`${server.origin}/enter/${user.accessKey}`, { redirect: 'manual' });
  assert.equal(res.status, 302, 'should redirect on valid key');
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('session='), 'should set a session cookie');
});

test('/enter/:accessKey rejects invalid key', async (t) => {
  const fixture = createTempDb();
  const server = await startTestServer({ db: fixture.db });
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const res = await fetch(`${server.origin}/enter/boguskey123`, { redirect: 'manual' });
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.ok(body.includes('Access key not recognized'));
});

test('/enter rejects old key after regeneration', async (t) => {
  const fixture = createTempDb();
  const server = await startTestServer({ db: fixture.db });
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const user = fixture.db.createUser('Regen User');
  const oldKey = user.accessKey;
  const newKey = fixture.db.regenerateAccessKey(user.id);

  const oldRes = await fetch(`${server.origin}/enter/${oldKey}`, { redirect: 'manual' });
  assert.equal(oldRes.status, 404, 'old key should be rejected');

  const newRes = await fetch(`${server.origin}/enter/${newKey}`, { redirect: 'manual' });
  assert.equal(newRes.status, 302, 'new key should work');
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

test('continue endpoint resolves referenced story as effective intent', async (t) => {
  const fixture = createTempDb();
  const calls = [];
  const ai = {
    configured: true,
    async chat(systemPrompt) {
      calls.push({ systemPrompt });
      return 'The lantern trembled in her hand.';
    },
  };
  const server = await startTestServer({ db: fixture.db, ai });
  const auth = createAuthState(fixture.db, 'Intent Ref User');
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const intentStory = fixture.db.createStory(auth.user.id, {
    title: 'Intent',
    initialContent: 'REFERENCED STORY GUIDANCE',
  });
  const mainStory = fixture.db.createStory(auth.user.id, { title: 'Main', initialContent: 'Body' });
  fixture.db.updateStory(mainStory.id, auth.user.id, { intent_story_id: intentStory.id });

  const response = await requestJson(server.origin, '/api/continue', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: {
      precedingText: 'Night settled over the lane.',
      followingText: '',
      storyIntent: 'inline fallback that should be ignored',
      storyId: mainStory.id,
      mode: 'default',
    },
  });

  assert.equal(response.res.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].systemPrompt, /REFERENCED STORY GUIDANCE/);
  assert.doesNotMatch(calls[0].systemPrompt, /inline fallback/);
});

test('continue endpoint falls back to inline intent when reference is missing', async (t) => {
  const fixture = createTempDb();
  const calls = [];
  const ai = {
    configured: true,
    async chat(systemPrompt) {
      calls.push({ systemPrompt });
      return 'The lantern trembled in her hand.';
    },
  };
  const server = await startTestServer({ db: fixture.db, ai });
  const auth = createAuthState(fixture.db, 'Intent Fallback User');
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const mainStory = fixture.db.createStory(auth.user.id, { title: 'Main', initialContent: 'Body' });
  // Dangling reference to a non-existent story.
  fixture.db.updateStory(mainStory.id, auth.user.id, { intent_story_id: 'does-not-exist' });

  const response = await requestJson(server.origin, '/api/continue', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: {
      precedingText: 'Night settled over the lane.',
      followingText: '',
      storyIntent: 'inline fallback guidance',
      storyId: mainStory.id,
      mode: 'default',
    },
  });

  assert.equal(response.res.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].systemPrompt, /inline fallback guidance/);
});

test('continue-premium endpoint uses chatPremium and parses best candidate', async (t) => {
  const fixture = createTempDb();
  const calls = [];
  const ai = {
    configured: true,
    async chatPremium(systemPrompt, userMessage, tier, userId) {
      calls.push({ systemPrompt, userMessage, tier, userId });
      return JSON.stringify({
        candidates: [
          { text: 'Weak sentence.', style: 3, metaphors: 2, plot: 4 },
          { text: 'The harbour bells tolled once, then silence swallowed the rest.', style: 9, metaphors: 8, plot: 9 },
          { text: 'Medium sentence.', style: 5, metaphors: 5, plot: 5 },
        ],
      });
    },
  };
  const server = await startTestServer({ db: fixture.db, ai });
  const auth = createAuthState(fixture.db, 'Premium User');
  fixture.db.setUserTier(auth.user.id, 'gold');
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const response = await requestJson(server.origin, '/api/continue-premium', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: {
      precedingText: 'Night settled over the lane.',
      followingText: '',
      storyIntent: 'Keep the tone tense.',
      mode: 'default',
    },
  });

  assert.equal(response.res.status, 200);
  assert.equal(response.json.sentence, 'The harbour bells tolled once, then silence swallowed the rest.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tier, 'gold');
  assert.match(calls[0].systemPrompt, /PHASE 1/);
  assert.match(calls[0].systemPrompt, /PHASE 2/);
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

test('recall endpoint uses fast provider path and returns normalized recall', async (t) => {
  const fixture = createTempDb();
  const calls = [];
  const ai = {
    configured: true,
    async chatWithProvider(systemPrompt, userMessage, providerName, userId) {
      calls.push({ systemPrompt, userMessage, providerName, userId });
      return ' John, the man keeping watch over the harbor. \n\n';
    },
  };
  const server = await startTestServer({ db: fixture.db, ai });
  const auth = createAuthState(fixture.db, 'Recall User');
  t.after(async () => {
    await server.close();
    fixture.cleanup();
  });

  const fullText = 'Opening\n\n---\nHarbor\nJohn watched the tide.';
  const selectedText = 'John';
  const start = fullText.indexOf(selectedText);
  const end = start + selectedText.length;
  const response = await requestJson(server.origin, '/api/recall', {
    method: 'POST',
    headers: { Cookie: auth.cookie },
    body: {
      fullText,
      selectedText,
      selectionStart: start,
      selectionEnd: end,
      storyIntent: 'Keep the note restrained.',
    },
  });

  assert.equal(response.res.status, 200);
  assert.equal(response.json.recall, 'John, the man keeping watch over the harbor.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerName, 'openaiMini');
  assert.match(calls[0].systemPrompt, /return NOTHING/);
  assert.match(calls[0].userMessage, /<recall>John<\/recall>/);
});
