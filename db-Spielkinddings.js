const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DB_PATH = path.join(__dirname, 'storytellers.db');

const VALID_TIERS = ['common', 'bronze', 'silver', 'gold', 'platinum'];
const DEFAULT_TIER = 'common';

function generateId() {
  return crypto.randomUUID();
}

function generateAccessKey() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashAccessKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const FIRST_STORY_STARTER_MANUSCRIPT = `Welcome to Signet

This is your manuscript space.
A quiet page with wide margins.
The text is all that matters.

When you’re writing and you get stuck, look for the Gem at the end of a paragraph.
Click it to receive exactly one continuation sentence.
Undo if it’s not yours.
Type CTRL/CMD + Enter to continue anywhere.

---
Chapters and intent

Chapters are separated by simple divider lines.
You can use:
*
---
-*-

The line right after a divider becomes the chapter title (like this one).

At the top, open the story panel to keep a Story Intent.
It's there to help the Gem stay in the right voice — quietly, without noise.
`;

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createDb(options = {}) {
  const dbPath = options.path || process.env.SIGNET_DB_PATH || DEFAULT_DB_PATH;
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  let db;

  function initSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        access_key_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        author TEXT,
        content_markdown TEXT NOT NULL,
        story_intent TEXT,
        chapter_intent TEXT,
        last_modified INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_stories_user_last_modified
        ON stories(user_id, last_modified DESC);

      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id);
    `);

    // Lightweight migrations for existing installs.
    const storyColumns = db.prepare('PRAGMA table_info(stories)').all();
    const hasAuthor = storyColumns.some((column) => column.name === 'author');
    if (!hasAuthor) {
      db.exec('ALTER TABLE stories ADD COLUMN author TEXT');
    }

    const userColumns = db.prepare('PRAGMA table_info(users)').all();
    const hasTier = userColumns.some((column) => column.name === 'tier');
    if (!hasTier) {
      db.exec(`ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT '${DEFAULT_TIER}'`);
    }
  }

  function getDb() {
    if (!db) {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      initSchema();
    }
    return db;
  }

  function now() {
    return nowFn();
  }

  function createUser(name) {
    const d = getDb();
    const id = generateId();
    const accessKey = generateAccessKey();
    const accessKeyHash = hashAccessKey(accessKey);
    d.prepare('INSERT INTO users (id, name, access_key_hash, tier, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, accessKeyHash, DEFAULT_TIER, now());
    return { id, name, accessKey };
  }

  function findUserByAccessKeyHash(hash) {
    return getDb().prepare('SELECT * FROM users WHERE access_key_hash = ?').get(hash);
  }

  function regenerateAccessKey(userId) {
    const d = getDb();
    const accessKey = generateAccessKey();
    const accessKeyHash = hashAccessKey(accessKey);
    const result = d.prepare('UPDATE users SET access_key_hash = ? WHERE id = ?').run(accessKeyHash, userId);
    if (result.changes === 0) {
      throw new Error(`User not found: ${userId}`);
    }
    d.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return accessKey;
  }

  function listUsers() {
    return getDb().prepare('SELECT id, name, tier, created_at FROM users ORDER BY created_at DESC').all();
  }

  function getUserTier(userId) {
    const row = getDb().prepare('SELECT tier FROM users WHERE id = ?').get(userId);
    return row ? row.tier : DEFAULT_TIER;
  }

  function setUserTier(userId, tier) {
    if (!VALID_TIERS.includes(tier)) {
      throw new Error(`Invalid tier "${tier}". Valid tiers: ${VALID_TIERS.join(', ')}`);
    }
    const result = getDb().prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, userId);
    if (result.changes === 0) {
      throw new Error(`User not found: ${userId}`);
    }
  }

  function createSession(userId) {
    const d = getDb();
    const id = generateId();
    const expiresAt = now() + SESSION_DURATION_MS;
    d.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(id, userId, expiresAt, now());
    return { id, expiresAt };
  }

  function findValidSession(sessionId) {
    const session = getDb().prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(sessionId, now());
    return session || null;
  }

  function deleteSession(sessionId) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  function cleanExpiredSessions() {
    getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  }

  function createStory(userId, options = {}) {
    const d = getDb();
    const id = generateId();
    const timestamp = now();
    const title = typeof options.title === 'string' ? options.title : '';
    const author = typeof options.author === 'string' ? options.author : '';
    const initialContent = options.initialContent !== undefined ? options.initialContent : '';
    d.prepare('INSERT INTO stories (id, user_id, title, author, content_markdown, story_intent, chapter_intent, last_modified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, title, author, initialContent, null, null, timestamp, timestamp);
    return { id, user_id: userId, title, author, content_markdown: initialContent, story_intent: null, chapter_intent: null, last_modified: timestamp, created_at: timestamp };
  }

  function getUserStories(userId) {
    return getDb().prepare('SELECT id, title, author, content_markdown, last_modified, created_at FROM stories WHERE user_id = ? ORDER BY last_modified DESC').all(userId);
  }

  function getStory(storyId, userId) {
    return getDb().prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?').get(storyId, userId) || null;
  }

  function updateStory(storyId, userId, fields) {
    const d = getDb();
    const allowed = ['title', 'author', 'content_markdown', 'story_intent'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    if (sets.length === 0) return null;
    sets.push('last_modified = ?');
    values.push(now());
    values.push(storyId, userId);
    d.prepare(`UPDATE stories SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
    return getStory(storyId, userId);
  }

  function deleteStory(storyId, userId) {
    return getDb().prepare('DELETE FROM stories WHERE id = ? AND user_id = ?').run(storyId, userId);
  }

  function close() {
    if (!db) return;
    db.close();
    db = null;
  }

  return {
    getDb,
    close,
    generateAccessKey,
    hashAccessKey,
    createUser,
    findUserByAccessKeyHash,
    regenerateAccessKey,
    listUsers,
    getUserTier,
    setUserTier,
    VALID_TIERS,
    DEFAULT_TIER,
    createSession,
    findValidSession,
    deleteSession,
    cleanExpiredSessions,
    createStory,
    getUserStories,
    getStory,
    updateStory,
    deleteStory,
    SESSION_DURATION_MS,
    FIRST_STORY_STARTER_MANUSCRIPT,
    dbPath,
  };
}

const defaultDb = createDb();

module.exports = {
  createDb,
  DEFAULT_DB_PATH,
  VALID_TIERS,
  DEFAULT_TIER,
  SESSION_DURATION_MS,
  FIRST_STORY_STARTER_MANUSCRIPT,
  ...defaultDb,
};
