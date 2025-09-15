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

// Health check
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

/**
 * Exile a user from the group.
 * POST /remove { robloxId } or { username }
 */
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

/**
 * Get list of group roles (id, name, rank number)
 * GET /ranks
 */
app.get('/ranks', async (req, res) => {
  try {
    await ensureLogin();
    const roles = await noblox.getRoles(Number(GROUP_ID)); // [{id, name, rank}]
    // Filter out Guest if present (rank 0)
    const filtered = roles.filter(r => r.rank > 0);
    return res.status(200).json({ ok: true, roles: filtered });
  } catch (err) {
    console.error('Get ranks failed:', err?.response?.data || err);
    return res.status(500).json({ error: 'get_ranks_failed' });
  }
});

/**
 * Set a user to a specific role by id or rank number
 * POST /set-rank { robloxId, roleId? , rankNumber? }
 */
app.post('/set-rank', async (req, res) => {
  try {
    await ensureLogin();
    const { robloxId, roleId, rankNumber } = req.body || {};
    if (!robloxId || isNaN(Number(robloxId))) {
      return res.status(400).json({ error: 'robloxId required' });
    }
    let targetRank = rankNumber;

    if (!targetRank && roleId) {
      const roles = await noblox.getRoles(Number(GROUP_ID));
      const role = roles.find(r => Number(r.id) === Number(roleId));
      if (!role) return res.status(400).json({ error: 'invalid_roleId' });
      targetRank = role.rank;
    }
    if (!targetRank || isNaN(Number(targetRank))) {
      return res.status(400).json({ error: 'rankNumber or roleId required' });
    }

    // noblox.setRank(groupId, userId, rankNumber)
    await noblox.setRank(Number(GROUP_ID), Number(robloxId), Number(targetRank));
    return res.status(200).json({ ok: true, robloxId: Number(robloxId), rankNumber: Number(targetRank) });
  } catch (err) {
    console.error('Set rank failed:', err?.response?.data || err);
    return res.status(500).json({ error: 'set_rank_failed' });
  }
});

const port = Number(PORT) || 8081;
app.listen(port, '0.0.0.0', () => {
  console.log(`Roblox service listening on :${port}`);
});
