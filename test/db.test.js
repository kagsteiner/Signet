const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createDb, hashAccessKey, SESSION_DURATION_MS } = require('../db');
const { createTempDb } = require('../test-support/temp-db');

test('hashAccessKey is deterministic', () => {
  assert.equal(hashAccessKey('abc'), hashAccessKey('abc'));
  assert.notEqual(hashAccessKey('abc'), hashAccessKey('abd'));
});

test('setUserTier validates tiers and updates stored user tier', (t) => {
  const fixture = createTempDb({ now: 1000 });
  t.after(() => fixture.cleanup());

  const user = fixture.db.createUser('Tiered User');

  fixture.db.setUserTier(user.id, 'gold');
  assert.equal(fixture.db.getUserTier(user.id), 'gold');
  assert.throws(() => fixture.db.setUserTier(user.id, 'diamond'), /Invalid tier/);
});

test('sessions expire deterministically and cleanup removes expired rows', (t) => {
  const fixture = createTempDb({ now: 5000 });
  t.after(() => fixture.cleanup());

  const user = fixture.db.createUser('Session User');
  const session = fixture.db.createSession(user.id);

  assert.equal(fixture.db.findValidSession(session.id).id, session.id);

  fixture.setNow(5000 + SESSION_DURATION_MS + 1);
  assert.equal(fixture.db.findValidSession(session.id), null);
  fixture.db.cleanExpiredSessions();

  const row = fixture.db.getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row, undefined);
});

test('story updates respect ownership and allowed fields', (t) => {
  const fixture = createTempDb({ now: 100 });
  t.after(() => fixture.cleanup());

  const userOne = fixture.db.createUser('Author One');
  const userTwo = fixture.db.createUser('Author Two');
  const story = fixture.db.createStory(userOne.id, { title: 'Draft', initialContent: 'Alpha' });

  const denied = fixture.db.updateStory(story.id, userTwo.id, { title: 'Nope' });
  const ignored = fixture.db.updateStory(story.id, userOne.id, { chapter_intent: 'ignored' });
  const updated = fixture.db.updateStory(story.id, userOne.id, {
    title: 'Published',
    content_markdown: 'Beta',
  });

  assert.equal(denied, null);
  assert.equal(ignored, null);
  assert.equal(updated.title, 'Published');
  assert.equal(updated.content_markdown, 'Beta');
});

test('createDb migrates existing installs with missing author and tier columns', (t) => {
  const fixture = createTempDb({ now: 100 });
  t.after(() => fixture.cleanup());

  const legacy = new Database(fixture.dbPath);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      access_key_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      content_markdown TEXT NOT NULL,
      story_intent TEXT,
      chapter_intent TEXT,
      last_modified INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  legacy.close();

  const migrated = createDb({ path: fixture.dbPath, now: () => 100 });
  const storyColumns = migrated.getDb().prepare('PRAGMA table_info(stories)').all();
  const userColumns = migrated.getDb().prepare('PRAGMA table_info(users)').all();

  assert.equal(storyColumns.some((column) => column.name === 'author'), true);
  assert.equal(userColumns.some((column) => column.name === 'tier'), true);

  migrated.close();
});
