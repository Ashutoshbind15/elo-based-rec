require("dotenv").config();

const express = require("express");
const { createLc0Client } = require("./lc0Client");

const PORT = Number(process.env.PORT || 8787);
const SHOULD_EAGER_INIT = process.env.LC0_EAGER_INIT === "true";

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = createLc0Client();
let server = null;

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/best-move", async (req, res) => {
  try {
    const { fen } = req.body || {};
    if (!fen || typeof fen !== "string") {
      res.status(400).json({ error: "Missing or invalid `fen` string" });
      return;
    }

    const bestMove = await client.getBestMove(fen.trim());
    res.json({ bestMove });
  } catch (error) {
    res.status(500).json({ error: error.message || "Engine request failed" });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

async function start() {
  if (SHOULD_EAGER_INIT) {
    await client.init();
  }

  server = app.listen(PORT, () => {
    process.stdout.write(`lc0 API listening on http://localhost:${PORT}\n`);
  });
}

async function shutdown() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await client.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((error) => {
  process.stderr.write(`Failed to start lc0 API: ${error.message}\n`);
  process.exit(1);
});
