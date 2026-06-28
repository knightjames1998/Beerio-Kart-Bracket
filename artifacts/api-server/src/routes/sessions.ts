import { Router, type IRouter } from "express";
import { store } from "../lib/store";

const router: IRouter = Router();

// Unambiguous alphabet (no I, L, O, 0, 1) for easy reading off a screen.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// Create a new live session, returns a short code.
router.post("/sessions", async (req, res) => {
  try {
    const state = req.body?.state;
    if (state === undefined) return res.status(400).json({ error: "missing state" });
    let code = genCode();
    for (let tries = 0; tries < 6; tries++) {
      const existing = await store.get(code);
      if (!existing) break;
      code = genCode();
    }
    await store.create(code, state);
    return res.json({ code });
  } catch (err) {
    req.log?.error({ err }, "create session failed");
    return res.status(500).json({ error: "server error" });
  }
});

// Host pushes the latest bracket state.
router.put("/sessions/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").toUpperCase();
    const state = req.body?.state;
    if (state === undefined) return res.status(400).json({ error: "missing state" });
    await store.update(code, state);
    return res.json({ ok: true });
  } catch (err) {
    req.log?.error({ err }, "update session failed");
    return res.status(500).json({ error: "server error" });
  }
});

// Spectator polls the latest state.
router.get("/sessions/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").toUpperCase();
    const data = await store.get(code);
    if (!data) return res.status(404).json({ error: "not found" });
    return res.json(data);
  } catch (err) {
    req.log?.error({ err }, "get session failed");
    return res.status(500).json({ error: "server error" });
  }
});

export default router;
