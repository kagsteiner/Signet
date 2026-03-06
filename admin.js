const db = require('./db');

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(`
Signet Admin CLI

Usage:
  node admin.js create-user <name>       Create a new user and print their access URL
  node admin.js list-users               List all users
  node admin.js regenerate-key <userId>  Regenerate access key for a user (revokes all sessions)
  `);
}

switch (command) {
  case 'create-user': {
    const name = args[1];
    if (!name) {
      console.error('Error: name is required');
      usage();
      process.exit(1);
    }
    const user = db.createUser(name);
    console.log(`\nUser created successfully.`);
    console.log(`  Name:   ${user.name}`);
    console.log(`  ID:     ${user.id}`);
    console.log(`\n  Access URL: /enter/${user.accessKey}`);
    console.log(`\n  Share the full URL with the user. This is their permanent key.`);
    console.log(`  The raw key is NOT stored — only its hash. Save it now if needed.\n`);
    break;
  }

  case 'list-users': {
    const users = db.listUsers();
    if (users.length === 0) {
      console.log('No users found.');
    } else {
      console.log('\nUsers:');
      for (const u of users) {
        const date = new Date(u.created_at).toISOString().slice(0, 10);
        console.log(`  ${u.name}  [${u.tier}]  (${u.id})  created ${date}`);
      }
      console.log('');
    }
    break;
  }

  case 'regenerate-key': {
    const userId = args[1];
    if (!userId) {
      console.error('Error: userId is required');
      usage();
      process.exit(1);
    }
    const newKey = db.regenerateAccessKey(userId);
    console.log(`\nAccess key regenerated. All existing sessions revoked.`);
    console.log(`\n  New Access URL: /enter/${newKey}`);
    console.log(`\n  Share with the user. Previous key is now invalid.\n`);
    break;
  }

  default:
    usage();
    break;
}
