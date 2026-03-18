const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDb } = require('../db');

function createTempDb(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signet-test-'));
  const dbPath = path.join(tempDir, 'storytellers.db');
  let nowValue = typeof options.now === 'number' ? options.now : Date.now();
  const db = createDb({
    path: dbPath,
    now: () => nowValue,
  });

  return {
    db,
    dbPath,
    tempDir,
    setNow(nextNow) {
      nowValue = nextNow;
    },
    cleanup() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

module.exports = {
  createTempDb,
};
