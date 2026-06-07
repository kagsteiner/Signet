# Signet

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
| `SIGNET_DB_PATH` | No | Path to the SQLite file (default: `storytellers.db` in the project directory). Use the same path for the server and admin/managedb CLIs. |
| `NODE_ENV` | No | Set to `production` for secure cookies |
| `DEEPSEEK_API_KEY` | For lower tiers | Used for **common**, **bronze**, and **silver** (Gem continuation, premium Gem, rewrite) |
| `ANTHROPIC_API_KEY` | For higher tiers | Used for **gold** and **platinum** (same features, Anthropic models) |
| `OPENAI_API_KEY` | For recall | Recall uses a fixed mini model (`gpt-5.4-mini`) via the OpenAI API |

At least one of `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` should be set so `ai.configured` is true; users on a tier whose provider has no key will get errors when using the Gem or rewrite.

## User tiers

Each user has a **tier** stored in the database. It controls which vendor and models power the standard Gem, **premium** Gem (multi-candidate continuation), and rewrite. New users are created as **common**.

| Tier | Backend | Standard Gem / rewrite | Premium Gem |
|---|---|---|---|
| `common` | DeepSeek | `deepseek-v4-flash` | `deepseek-v4-pro` (thinking) |
| `bronze` | DeepSeek | same as common | same as common |
| `silver` | DeepSeek | same as common | same as common |
| `gold` | Anthropic | `claude-sonnet-4-6` | `claude-opus-4-6` |
| `platinum` | Anthropic | same as gold | same as gold |

Tiers are ordered roughly by “cost / capability” toward the top: **common** is the default; **gold** and **platinum** use the more expensive Anthropic stack. **Bronze** and **silver** currently share the same routing as **common** (see `tierToProvider` in `ai.js`).

### Changing a user’s tier

Use the **managedb** CLI (from the project root, with the same `SIGNET_DB_PATH` as the running server if you set it):

```bash
node managedb.js setusertier <user_id_or_name> <tier>
# examples:
node managedb.js setusertier Karlheinz gold
npm run managedb -- setusertier a1b2c3d4-e5f6-7890-abcd-ef1234567890 platinum
```

The first argument can be the user’s **UUID** (from `node admin.js list-users`) or their **display name** if it matches exactly one user (case-insensitive). Tier names are lowercase: `common`, `bronze`, `silver`, `gold`, `platinum`.

See also `README.managedb.md` for listing users, stories, and deleting stories.

## Running

```bash
# Development
npm start

# With AI features (set keys for the tiers you use — see table above)
DEEPSEEK_API_KEY=... ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npm start
```

## Story intent

Each story can carry a **story intent** — notes on direction, planned chapters, and tone. The Gem, rewrite, and recall use it as background guidance (not as established fact in the manuscript).

Open the **story panel** (click the story title at the top) and find **Story Intent**. You can either:

- **Write directly** — enter intent in the textarea, as before.
- **Use another story** — choose one of your other stories from the dropdown. That story’s manuscript becomes this story’s intent, so you can write a long or LLM-assisted intent in the full editor and link it here. Inline text is kept if you switch back to “Write directly.”

When a story is linked as intent, the panel shows which story is in use and an **Open** button to jump to it.

## Admin CLI

```bash
# Create a user (prints their permanent access URL)
node admin.js create-user "Author Name"

# List all users
node admin.js list-users

# Regenerate access key (revokes all sessions; <userId> is the UUID from list-users)
node admin.js regenerate-key <userId>
```

## Architecture

- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **Frontend**: Pure JavaScript, no framework
- **Auth**: Invitation-only lifetime access URLs with 30-day sessions
- **AI**: Tier-based routing (DeepSeek / Anthropic) for the Gem and rewrite; OpenAI mini for recall
