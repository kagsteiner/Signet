# Storytellers V2

A private, invitation-only writing studio. Minimal, literary, calm.

## Setup

```bash
npm install
```

## Configuration

Set environment variables before starting:

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 3005) |
| `BASE_PATH` | No | When behind a subpath (e.g. nginx at `/signet/`), set to `BASE_PATH=/signet` so redirects and cookies work |
| `OPENAI_API_KEY` | Yes (for AI) | OpenAI API key for Gem continuation and rewrite |
| `NODE_ENV` | No | Set to `production` for secure cookies |

## Running

```bash
# Development
npm start

# With AI features
OPENAI_API_KEY=sk-... npm start
```

## Admin CLI

```bash
# Create a user (prints their permanent access URL)
node admin.js create-user "Author Name"

# List all users
node admin.js list-users

# Regenerate access key (revokes all sessions)
node admin.js regenerate-key <userId>
```

## Architecture

- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **Frontend**: Pure JavaScript, no framework
- **Auth**: Invitation-only lifetime access URLs with 30-day sessions
- **AI**: OpenAI API for continuation (the Gem) and rewrite
