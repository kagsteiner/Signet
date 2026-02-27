const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'storytellers.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

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
      title TEXT NOT NULL,
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
}

function generateId() {
  return crypto.randomUUID();
}

function generateAccessKey() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashAccessKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function now() {
  return Date.now();
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

// --- User operations ---

function createUser(name) {
  const d = getDb();
  const id = generateId();
  const accessKey = generateAccessKey();
  const accessKeyHash = hashAccessKey(accessKey);
  d.prepare('INSERT INTO users (id, name, access_key_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, accessKeyHash, now());
  return { id, name, accessKey };
}

function findUserByAccessKeyHash(hash) {
  return getDb().prepare('SELECT * FROM users WHERE access_key_hash = ?').get(hash);
}

function regenerateAccessKey(userId) {
  const d = getDb();
  const accessKey = generateAccessKey();
  const accessKeyHash = hashAccessKey(accessKey);
  d.prepare('UPDATE users SET access_key_hash = ? WHERE id = ?').run(accessKeyHash, userId);
  d.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return accessKey;
}

function listUsers() {
  return getDb().prepare('SELECT id, name, created_at FROM users ORDER BY created_at DESC').all();
}

// --- Session operations ---

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

// --- Story operations ---

function createStory(userId, title = 'Untitled', options = {}) {
  const d = getDb();
  const id = generateId();
  const timestamp = now();
  const initialContent = options.initialContent !== undefined ? options.initialContent : '';
  d.prepare('INSERT INTO stories (id, user_id, title, content_markdown, story_intent, chapter_intent, last_modified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, title, initialContent, null, null, timestamp, timestamp);
  return { id, user_id: userId, title, content_markdown: initialContent, story_intent: null, chapter_intent: null, last_modified: timestamp, created_at: timestamp };
}

function getUserStories(userId) {
  return getDb().prepare('SELECT id, title, last_modified, created_at FROM stories WHERE user_id = ? ORDER BY last_modified DESC').all(userId);
}

function getStory(storyId, userId) {
  return getDb().prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?').get(storyId, userId) || null;
}

function updateStory(storyId, userId, fields) {
  const d = getDb();
  const allowed = ['title', 'content_markdown', 'story_intent'];
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

module.exports = {
  getDb,
  generateAccessKey,
  hashAccessKey,
  createUser,
  findUserByAccessKeyHash,
  regenerateAccessKey,
  listUsers,
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
};
