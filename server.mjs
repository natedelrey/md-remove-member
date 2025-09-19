import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import noblox from "noblox.js";

/**
 * =========================
 * ENV REQUIRED
 * =========================
 * PORT                    (optional; defaults to 8080)
 * ROBLOSECURITY           (cookie of the ranker account)
 * ROBLOX_GROUP_ID         (numeric group id)
 * RANK_SERVICE_SECRET     (shared secret; X-Secret-Key must equal this)
 */

const PORT = Number(process.env.PORT || 8080);
const GROUP_ID = Number(process.env.ROBLOX_GROUP_ID || 0);
const SERVICE_SECRET = process.env.RANK_SERVICE_SECRET || process.env.ROBLOX_REMOVE_SECRET; // allow reuse
const COOKIE = process.env.ROBLOSECURITY;

if (!COOKIE) {
  console.error("[fatal] ROBLOSECURITY env not set.");
  process.exit(1);
}
if (!GROUP_ID) {
  console.error("[fatal] ROBLOX_GROUP_ID env not set/invalid.");
  process.exit(1);
}
if (!SERVICE_SECRET) {
  console.error("[fatal] RANK_SERVICE_SECRET (or ROBLOX_REMOVE_SECRET) env not set.");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---- Auth & retry helpers ----
let authed = false;

async function ensureAuth() {
  if (authed) return;
  await noblox.setCookie(COOKIE);
  // sanity check
  const me = await noblox.getCurrentUser();
  if (!me?.UserID) throw new Error("Roblox auth sanity check failed");
  console.log(`[svc] Authenticated as ${me.UserName} (${me.UserID})`);
  authed = true;
}

function isCsrfError(err) {
  const msg = String(err?.message || err || "");
  return /X-?CSRF/i.test(msg) || msg.includes("Did not receive X-CSRF-TOKEN");
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withAuthRetry(fn, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await ensureAuth();
      return await fn();
    } catch (err) {
      console.error(`[svc] attempt ${i} failed:`, err?.message || err);
      if (isCsrfError(err) && i < tries) {
        authed = false; // force relogin
        await delay(1500);
        continue;
      }
      throw err;
    }
  }
}

function requireSecret(req, res) {
  const got = req.get("X-Secret-Key");
  if (got !== SERVICE_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

// ---- Routes ----

// Health check (also verifies login)
app.get("/health", async (req, res) => {
  try {
    await ensureAuth();
    res.json({ ok: true, groupId: GROUP_ID });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Get roles/ranks for the group (used for /rank autocomplete)
app.get("/ranks", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const roles = await withAuthRetry(() => noblox.getRoles(GROUP_ID));
    // roles: [{ id, name, rank }, ...]
    res.json({ roles });
  } catch (e) {
    console.error("[/ranks] error:", e?.message || e);
    res.status(500).json({ error: "ranks_failed" });
  }
});

// Set a user's rank (roleId OR rankNumber)
app.post("/set-rank", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { robloxId, roleId, rankNumber } = req.body || {};
  if (!robloxId || (roleId == null && rankNumber == null)) {
    return res.status(400).json({ error: "missing_params" });
  }

  try {
    await withAuthRetry(async () => {
      if (roleId != null) {
        await noblox.setRank({ group: GROUP_ID, target: Number(robloxId), role: Number(roleId) });
      } else {
        await noblox.setRank({ group: GROUP_ID, target: Number(robloxId), rank: Number(rankNumber) });
      }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Set rank failed:", e?.message || e);
    res.status(500).json({ error: "set_rank_failed" });
  }
});

// Remove/exile a user from the group (used by Python on orientation expiry)
app.post("/remove", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { robloxId } = req.body || {};
  if (!robloxId) return res.status(400).json({ error: "missing_robloxId" });

  try {
    await withAuthRetry(() => noblox.exile(GROUP_ID, Number(robloxId)));
    res.json({ ok: true });
  } catch (e) {
    console.error("Remove (exile) failed:", e?.message || e);
    res.status(500).json({ error: "remove_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Roblox service listening on :${PORT}`);
});
