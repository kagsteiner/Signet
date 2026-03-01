const db = require('./db');

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`
Signet DB Manager

Usage:
  node managedb.js liststories
  node managedb.js deletestory <id>
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

  default:
    usage();
    break;
}
