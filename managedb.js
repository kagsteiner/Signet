const db = require('./db');

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`
Signet DB Manager

Usage:
  node managedb.js liststories
  node managedb.js deletestory <id>
  node managedb.js listusers
  node managedb.js setusertier <user_id_or_name> <tier>

Valid tiers: ${db.VALID_TIERS.join(', ')}
`);
}

function listStories() {
  const rows = db.getDb().prepare(`
    SELECT
      stories.id AS id,
      stories.title AS title,
      users.name AS user_name
    FROM stories
    INNER JOIN users ON users.id = stories.user_id
    ORDER BY stories.last_modified DESC
  `).all();

  if (rows.length === 0) {
    console.log('No stories found.');
    return;
  }

  console.log('\nStories:');
  for (const row of rows) {
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : '(untitled)';
    console.log(`  ${row.id} | ${title} | ${row.user_name}`);
  }
  console.log('');
}

function deleteStoryById(storyId) {
  const result = db.getDb().prepare('DELETE FROM stories WHERE id = ?').run(storyId);
  if (result.changes === 0) {
    console.error(`Story not found: ${storyId}`);
    process.exit(1);
  }
  console.log(`Deleted story: ${storyId}`);
}

function listUsers() {
  const users = db.listUsers();
  if (users.length === 0) {
    console.log('No users found.');
    return;
  }

  console.log('\nUsers:');
  for (const u of users) {
    const date = new Date(u.created_at).toISOString().slice(0, 10);
    console.log(`  ${u.name}  [${u.tier}]  (${u.id})  created ${date}`);
  }
  console.log('');
}

function resolveUserId(identifier) {
  const byId = db.getDb().prepare('SELECT id, name FROM users WHERE id = ?').get(identifier);
  if (byId) return byId;

  const byName = db.getDb().prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE').all(identifier);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    console.error(`Multiple users match name "${identifier}". Use the user ID instead:`);
    for (const u of byName) console.error(`  ${u.name}  (${u.id})`);
    process.exit(1);
  }
  return null;
}

function setUserTier(identifier, tier) {
  const user = resolveUserId(identifier);
  if (!user) {
    console.error(`User not found: ${identifier}`);
    process.exit(1);
  }

  try {
    db.setUserTier(user.id, tier);
    console.log(`Set tier for ${user.name} (${user.id}) to: ${tier}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

switch (command) {
  case 'liststories':
    listStories();
    break;

  case 'deletestory': {
    const storyId = args[1];
    if (!storyId) {
      console.error('Error: story id is required');
      usage();
      process.exit(1);
    }
    deleteStoryById(storyId);
    break;
  }

  case 'listusers':
    listUsers();
    break;

  case 'setusertier': {
    const userArg = args[1];
    const tierArg = args[2];
    if (!userArg || !tierArg) {
      console.error('Error: user and tier are required');
      usage();
      process.exit(1);
    }
    setUserTier(userArg, tierArg.toLowerCase());
    break;
  }

  default:
    usage();
    break;
}
