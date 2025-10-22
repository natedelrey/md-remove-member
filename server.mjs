import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import noblox from "noblox.js";

/**
 * ENV:
 *  PORT (default 8080)
 *  ROBLOSECURITY        - cookie for your bot account
 *  ROBLOX_GROUP_ID      - numeric group id
 *  RANK_SERVICE_SECRET  - shared secret (used as X-Secret-Key)
 *  (back-compat) ROBLOX_REMOVE_SECRET also accepted for X-Secret-Key
 */

const PORT = Number(process.env.PORT || 8080);
const GROUP_ID = Number(process.env.ROBLOX_GROUP_ID || process.env.GROUP_ID || 0);
const SERVICE_SECRET = process.env.RANK_SERVICE_SECRET || process.env.ROBLOX_REMOVE_SECRET || process.env.SERVICE_SECRET;
const COOKIE = process.env.ROBLOSECURITY;

if (!COOKIE) { console.error("[fatal] ROBLOSECURITY not set"); process.exit(1); }
if (!GROUP_ID) { console.error("[fatal] ROBLOX_GROUP_ID/GROUP_ID not set/invalid"); process.exit(1); }
if (!SERVICE_SECRET) { console.error("[fatal] RANK_SERVICE_SECRET (or ROBLOX_REMOVE_SECRET) not set"); process.exit(1); }

const app = express();
app.use(cors());
app.use(bodyParser.json());

let authed = false;

async function ensureAuth() {
  if (authed) return;
  await noblox.setCookie(COOKIE);
  const me = await noblox.getCurrentUser();
  if (!me?.UserID) throw new Error("Roblox auth sanity check failed");
  console.log(`[svc] Authenticated as ${me.UserName} (${me.UserID})`);
  authed = true;
}

function isCsrfError(err) {
  const msg = String(err?.message || err || "");
  return /X-?CSRF/i.test(msg) || msg.includes("Did not receive X-CSRF-TOKEN");
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function withAuthRetry(fn, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await ensureAuth();
      return await fn();
    } catch (err) {
      console.error(`[svc] attempt ${i} failed:`, err?.message || err);
      if (isCsrfError(err) && i < tries) { authed = false; await delay(1500); continue; }
      throw err;
    }
  }
}

function requireSecret(req, res) {
  const got = req.get("X-Secret-Key");
  if (got !== SERVICE_SECRET) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}

// --- Routes ---

app.get("/health", async (_req, res) => {
  try { await ensureAuth(); res.json({ ok: true, groupId: GROUP_ID }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

// Ranks for autocomplete
app.get("/ranks", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const roles = await withAuthRetry(() => noblox.getRoles(GROUP_ID));
    res.json({ roles });
  } catch (e) {
    console.error("[/ranks] error:", e?.message || e);
    res.status(500).json({ error: "ranks_failed" });
  }
});

// Accept a specific pending join request
app.post("/accept-join", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { robloxId } = req.body || {};
  if (!robloxId) return res.status(400).json({ error: "missing_robloxId" });

  try {
    // If they actually have a pending request, accept it. If not, this will no-op/throw harmlessly.
    await withAuthRetry(() => noblox.handleJoinRequest(GROUP_ID, Number(robloxId), true));
    res.json({ ok: true });
  } catch (e) {
    console.error("[/accept-join] failed:", e?.message || e);
    res.status(500).json({ error: "accept_join_failed" });
  }
});

// Set rank: accepts either { roleId } OR { rankNumber }
app.post("/set-rank", async (req, res) => {
  if (!requireSecret(req, res)) return;

  let { robloxId, roleId, rankNumber } = req.body || {};
  if (!robloxId) return res.status(400).json({ error: "missing_robloxId" });

  try {
    let rankToSet = null;

    if (roleId != null) {
      // Translate roleId -> rankNumber
      const roles = await withAuthRetry(() => noblox.getRoles(GROUP_ID));
      const role = roles.find(r => Number(r.id) === Number(roleId));
      if (!role) return res.status(400).json({ error: "invalid_roleId" });
      rankToSet = Number(role.rank);
    } else if (rankNumber != null) {
      rankToSet = Number(rankNumber);
    } else {
      return res.status(400).json({ error: "missing_roleId_or_rankNumber" });
    }

    await withAuthRetry(() => noblox.setRank(GROUP_ID, Number(robloxId), rankToSet));
    res.json({ ok: true, appliedRank: rankToSet });
  } catch (e) {
    console.error("[/set-rank] failed:", e?.message || e);
    res.status(500).json({ error: "set_rank_failed" });
  }
});

// Exile/remove from group
app.post("/remove", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { robloxId } = req.body || {};
  if (!robloxId) return res.status(400).json({ error: "missing_robloxId" });

  try {
    await withAuthRetry(() => noblox.exile(GROUP_ID, Number(robloxId)));
    res.json({ ok: true });
  } catch (e) {
    console.error("[/remove] failed:", e?.message || e);
    res.status(500).json({ error: "remove_failed" });
  }
});

// Convenience: accept if pending, then set rank in one call
app.post("/ensure-member-and-rank", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { robloxId, rankNumber, roleId } = req.body || {};
  if (!robloxId) return res.status(400).json({ error: "missing_robloxId" });

  try {
    // Try to accept join request (if there is one)
    try {
      await withAuthRetry(() => noblox.handleJoinRequest(GROUP_ID, Number(robloxId), true));
    } catch (_) {
      // ignore — they might already be in, or no pending request
    }

    let rankToSet = null;
    if (roleId != null) {
      const roles = await withAuthRetry(() => noblox.getRoles(GROUP_ID));
      const role = roles.find(r => Number(r.id) === Number(roleId));
      if (!role) return res.status(400).json({ error: "invalid_roleId" });
      rankToSet = Number(role.rank);
    } else if (rankNumber != null) {
      rankToSet = Number(rankNumber);
    } else {
      return res.status(400).json({ error: "missing_roleId_or_rankNumber" });
    }

    await withAuthRetry(() => noblox.setRank(GROUP_ID, Number(robloxId), rankToSet));
    res.json({ ok: true, appliedRank: rankToSet });
  } catch (e) {
    console.error("[/ensure-member-and-rank] failed:", e?.message || e);
    res.status(500).json({ error: "ensure_member_rank_failed" });
  }
});

app.listen(PORT, () => console.log(`Roblox service listening on :${PORT}`));
