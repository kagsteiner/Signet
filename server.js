require('dotenv').config({ override: true });

const { createApp } = require('./app-server');

const PORT = process.env.PORT || 3005;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Signet running on port ${PORT}`);
});
