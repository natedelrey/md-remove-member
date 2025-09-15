import 'dotenv/config';
import express from 'express';
import noblox from 'noblox.js';

const {
  PORT,                 // Railway injects this
  GROUP_ID,
  ROBLOSECURITY,
  SERVICE_SECRET
} = process.env;

if (!GROUP_ID || !ROBLOSECURITY || !SERVICE_SECRET) {
  console.error('Missing GROUP_ID / ROBLOSECURITY / SERVICE_SECRET');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// Health check (Railway friendly)
app.get('/', (req, res) => res.status(200).send('OK'));

// Shared-secret auth
app.use((req, res, next) => {
  const key = req.header('X-Secret-Key');
  if (!key || key !== SERVICE_SECRET) return res.sendStatus(401);
  next();
});

let loggedIn = false;
async function ensureLogin() {
  if (!loggedIn) {
    await noblox.setCookie(ROBLOSECURITY);
    loggedIn = true;
    console.log('Roblox session established');
  }
}

// POST /remove { robloxId } or { username }
app.post('/remove', async (req, res) => {
  try {
    await ensureLogin();

    let { robloxId, username } = req.body || {};
    if (!robloxId && username) {
      robloxId = await noblox.getIdFromUsername(username).catch(() => null);
    }
    if (!robloxId || isNaN(Number(robloxId))) {
      return res.status(400).json({ error: 'robloxId (or valid username) required' });
    }

    await noblox.exile(Number(GROUP_ID), Number(robloxId));
    return res.status(200).json({ ok: true, robloxId: Number(robloxId) });
  } catch (err) {
    console.error('Removal failed:', err?.response?.data || err);
    return res.status(500).json({ error: 'removal_failed' });
  }
});

// Use Railway’s provided PORT or default for local dev
const port = Number(PORT) || 8081;
app.listen(port, '0.0.0.0', () => {
  console.log(`Removal service listening on :${port}`);
});
