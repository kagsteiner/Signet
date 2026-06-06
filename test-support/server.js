const http = require('node:http');
const { once } = require('node:events');

const { createApp } = require('../app-server');

async function startTestServer(options = {}) {
  const app = createApp({
    db: options.db,
    ai: options.ai,
    prompts: options.prompts,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...options.env,
    },
    enableCleanupTimer: false,
  });

  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    app,
    server,
    origin,
    async close() {
      if (app.locals && app.locals.signet && typeof app.locals.signet.dispose === 'function') {
        app.locals.signet.dispose();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createAuthState(db, name = 'Test User') {
  const user = db.createUser(name);
  const session = db.createSession(user.id);
  return {
    user,
    session,
    cookie: `session=${session.id}`,
  };
}

module.exports = {
  startTestServer,
  createAuthState,
};
