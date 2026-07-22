import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { compileForSession } from "./compileService.js";
import { isValidSessionId } from "./session.js";

const app = express();

app.use(cors({ origin: config.corsOrigin, exposedHeaders: ["X-Cache", "X-Compile-Ms"] }));
// JSON-escaping a backslash-heavy LaTeX source can nearly double its size,
// so this transport limit is set well above config.maxSourceBytes (the
// actual enforced limit, checked below on the decoded string).
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/compile", async (req, res) => {
  const sessionId = req.header("x-session-id");
  if (!isValidSessionId(sessionId)) {
    res.status(400).json({ error: "Missing or invalid X-Session-Id header (expected a UUID)." });
    return;
  }

  const { source } = req.body ?? {};
  if (typeof source !== "string" || source.length === 0) {
    res.status(400).json({ error: "Request body must be JSON: { source: string }" });
    return;
  }
  if (Buffer.byteLength(source, "utf8") > config.maxSourceBytes) {
    res.status(413).json({ error: `Document is too large (max ${config.maxSourceBytes} bytes).` });
    return;
  }

  try {
    const result = await compileForSession(sessionId, source);

    res.setHeader("X-Cache", result.cacheHit ? "HIT" : "MISS");
    res.setHeader("X-Compile-Ms", String(result.durationMs));

    if (result.ok && result.pdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.status(200).send(result.pdf);
      return;
    }

    res.status(422).json({ error: result.log || "Compilation failed." });
  } catch (err) {
    console.error("Compile request failed:", err);
    res.status(500).json({ error: "Internal server error while compiling." });
  }
});

app.listen(config.port, () => {
  console.log(`mini-overleaf backend listening on http://localhost:${config.port}`);
});
