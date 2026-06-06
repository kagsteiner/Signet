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

test('createUser returns user with valid access key', (t) => {
  const fixture = createTempDb({ now: 1000 });
  t.after(() => fixture.cleanup());

  const user = fixture.db.createUser('Alice');
  assert.equal(user.name, 'Alice');
  assert.ok(user.id, 'user should have an id');
  assert.ok(user.accessKey, 'user should have an accessKey');

  const hash = hashAccessKey(user.accessKey);
  const found = fixture.db.findUserByAccessKeyHash(hash);
  assert.equal(found.id, user.id);
  assert.equal(found.name, 'Alice');
});

test('createUser gives each user a unique key', (t) => {
  const fixture = createTempDb({ now: 1000 });
  t.after(() => fixture.cleanup());

  const a = fixture.db.createUser('A');
  const b = fixture.db.createUser('B');
  assert.notEqual(a.accessKey, b.accessKey);
  assert.notEqual(a.id, b.id);
});

test('regenerateAccessKey invalidates old key and returns a working new one', (t) => {
  const fixture = createTempDb({ now: 1000 });
  t.after(() => fixture.cleanup());

  const user = fixture.db.createUser('Bob');
  const oldKey = user.accessKey;
  const session = fixture.db.createSession(user.id);
  assert.ok(fixture.db.findValidSession(session.id), 'session should be valid before regeneration');

  const newKey = fixture.db.regenerateAccessKey(user.id);
  assert.notEqual(newKey, oldKey);

  const oldLookup = fixture.db.findUserByAccessKeyHash(hashAccessKey(oldKey));
  assert.equal(oldLookup, undefined, 'old key should no longer resolve');

  const newLookup = fixture.db.findUserByAccessKeyHash(hashAccessKey(newKey));
  assert.equal(newLookup.id, user.id, 'new key should resolve to the same user');

  assert.equal(fixture.db.findValidSession(session.id), null, 'existing sessions should be revoked');
});

test('regenerateAccessKey throws for nonexistent userId', (t) => {
  const fixture = createTempDb({ now: 1000 });
  t.after(() => fixture.cleanup());

  assert.throws(() => fixture.db.regenerateAccessKey('no-such-id'), /User not found/);
});

test('listUsers returns all created users without access keys', (t) => {
  const fixture = createTempDb({ now: 1000 });
  t.after(() => fixture.cleanup());

  fixture.db.createUser('Carol');
  fixture.db.createUser('Dave');
  const users = fixture.db.listUsers();

  assert.equal(users.length, 2);
  const names = users.map(u => u.name).sort();
  assert.deepEqual(names, ['Carol', 'Dave']);
  for (const u of users) {
    assert.ok(u.id);
    assert.ok(u.created_at);
    assert.equal(u.access_key_hash, undefined, 'listUsers should not expose the hash');
    assert.equal(u.accessKey, undefined, 'listUsers should not expose the key');
  }
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
