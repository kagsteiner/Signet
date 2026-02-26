# 📜 Storytellers V2 — Complete System Specification

## 0. Core Identity

Storytellers is a private, invitation-only, multi-device writing studio.

It is:
- Minimal
- Literary
- Calm
- AI-assisted only at key moments
- Server-backed
- Multi-story per user
- Invitation-only (no public signup)

The application must feel like opening a manuscript, not using software.

The Gem is the soul of the application.

---

## 1. Design Philosophy

1. The text is sacred.
2. No dashboard.
3. No SaaS vibe.
4. No feature overload.
5. No visible AI controls.
6. No chat interface.
7. The user always lands directly inside a manuscript.

Aesthetic:
- Warm paper tone background
- Wide margins
- Generous line height
- Clean literary serif typography
- Minimal UI chrome

---

## 2. Architecture Overview

### Backend
- Node.js (Express)
- SQLite (better-sqlite3)
- HTTPS behind nginx
- Cookie-based session authentication
- REST API

### Frontend
- Pure JavaScript
- Fetch API
- No PWA
- No service workers
- No client-side persistence
- Server is single source of truth

---

## 3. Authentication Model

### 3.1 Invitation-Only Lifetime Access URL

Each user receives a permanent personal URL:

https://yourapp.com/enter/<very_long_random_key>

Properties:
- Key length ≥ 48 random bytes (cryptographically secure)
- Store only SHA-256 hash of key in database
- Never store raw key
- No passwords
- No email system
- No public registration
- Admin can regenerate key to revoke access

This URL is the user’s master key.

---

### 3.2 Session Model

When user visits /enter/:accessKey:

1. Hash provided key
2. Compare with stored hash
3. If valid:
   - Create session record in DB
   - Set HTTP-only, Secure, SameSite=Lax cookie
   - Expiration: 30 days
4. Redirect to /app

After 30 days:
- Session expires
- User revisits personal access URL
- No admin involvement required

---

## 4. Database Schema

### users
- id (TEXT PRIMARY KEY)
- name (TEXT NOT NULL)
- access_key_hash (TEXT NOT NULL)
- created_at (INTEGER NOT NULL)

### sessions
- id (TEXT PRIMARY KEY)
- user_id (TEXT NOT NULL)
- expires_at (INTEGER NOT NULL)
- created_at (INTEGER NOT NULL)

### stories
- id (TEXT PRIMARY KEY)
- user_id (TEXT NOT NULL)
- title (TEXT NOT NULL)
- content_markdown (TEXT NOT NULL)
- story_intent (TEXT)
- last_modified (INTEGER NOT NULL)
- created_at (INTEGER NOT NULL)

Index:
CREATE INDEX idx_stories_user_last_modified
ON stories(user_id, last_modified DESC);

---

## 5. Multi-Story Model

Each user can have multiple stories.

### App Launch Behavior

After authentication:
- If 0 stories → create “Untitled”
- If 1 story → open it
- If multiple stories → open most recently edited

No dashboard.
User always lands directly inside writing.

---

## 6. Story Switching UX

The story title (top-left) is clickable.

Clicking opens minimal overlay:

Stories
────────────
Story A (Today)
Story B (3 days ago)
Story C (Jan 4)

+ New Story
Export as Markdown
Export as Plain Text

Selecting a story loads it immediately.
Overlay disappears.

---

## 7. Manuscript Editor

Requirements:
- Single flowing document
- Markdown storage
- `##` headings for chapters
- Wide margins
- Generous line height
- Warm paper background
- No formatting toolbar
- No visible save button

Auto-save:
- Debounced (1–2 seconds)
- Save on every change via PUT

Top-right subtle indicator:
- “Saving…”
- “Saved”

---

## 8. Hidden Intent System

At top of document, collapsed section:
“Story Intent”

Contains:
- Global Story Intent

These:
- Not rendered in visible manuscript
- Stored in DB
- Sent to AI during continuation
- Plain text only

---

## 9. The Gem (Core Feature)

### 9.1 Appearance

- Appears at end of paragraph
- Only if paragraph ends with `.`
- Cursor is at paragraph end
- Centered below paragraph
- Symbol: ◇
- No animation
- No pulsing
- No hover effects

Example:

The wind carried the scent of iron through the valley.

    ◇

---

### 9.2 Behavior

When clicked:
1. Gem disappears
2. Backend generates exactly one sentence
3. Sentence inserted as new paragraph
4. Cursor placed at end
5. Gem reappears below new paragraph

Undo must work normally.

No chat.
No explanation.
No multiple sentences.

---

### 9.3 Keyboard Shortcut

Cmd + Enter triggers continuation anywhere.

Behavior:
- Gem briefly darkens (~300ms)
- Continuation generated

First time Gem is used:
Small grey hint appears briefly:
“Tip: ⌘↩ continues anywhere.”
Never shown again.

---

## 10. AI Continuation Rules

AI must:
- Generate exactly one complete sentence
- Match tense
- Match POV
- Match tone
- Avoid clichés
- Avoid exposition dumps
- Avoid meta commentary
- Avoid summarizing
- Maximum ~25–30 words
- Never output more than one sentence
- Never explain itself

Continuation must feel like a natural next beat.

---

## 11. Rewrite Selection (Secondary Feature)

Interaction:
- User selects text
- Subtle shimmer appears
- Clicking opens inline input:
  Placeholder: “Transform…”
- User types instruction
- Backend returns transformed version
- Show diff preview
- Accept or Reject

No chat.
No side panel.
Rewrite must not compete with the Gem.

---

## 12. API Endpoints

Authentication:
GET /enter/:accessKey

Stories:
GET    /api/stories
GET    /api/stories/:id
POST   /api/stories
PUT    /api/stories/:id
DELETE /api/stories/:id (optional)

---

## 13. Security Requirements

- Access key ≥ 48 random bytes
- Store only hash of key
- Sessions stored server-side
- Cookies:
  - HttpOnly
  - Secure
  - SameSite=Lax
- Rate limit /enter/:key
- Admin ability to regenerate access key

---

## 14. Non-Goals

- No public signup
- No password system
- No email infrastructure
- No PWA
- No service workers
- No collaboration
- No character database panel
- No heavy formatting UI
- No SaaS dashboard

---

## 15. MVP Scope

Must implement:
- Invitation-only lifetime access URL
- 30-day session authentication
- Multi-story support
- Auto-save
- Story switching overlay
- Hidden intent fields
- The Gem continuation
- Rewrite selection
- Warm literary aesthetic