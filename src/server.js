const path = require("path");
const express = require("express");
const { execFileSync } = require("child_process");
const { detectRunCommand, RunManager } = require("./run");
const { info, warn } = require("./logger");

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_DIFF_CHARS = 8000;

function parseCheckpointText(text) {
  const lines = text.split("\n");
  const data = {};
  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const value = rest.join(":").trim();
    switch (key.trim()) {
      case "ID":
        data.id = value;
        break;
      case "Git":
        data.gitSha = value;
        break;
      case "Checkpoint":
        data.title = value;
        break;
      case "Message":
        data.message = value;
        break;
      case "Diff":
        data.diff = value;
        break;
      case "Files":
        data.files = value.split(",").map((v) => v.trim()).filter(Boolean);
        break;
      case "Run":
        data.runCommand = value;
        break;
      case "Source":
        data.source = value;
        break;
      default:
        break;
    }
  }
  return data;
}

function truncateText(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function shortenShas(text) {
  // Shorten 40-character git SHAs to 7 characters
  return text.replace(/\b([a-f0-9]{40})\b/g, (match) => match.slice(0, 7));
}

function buildCheckpointSystemPrompt({ context, diffContext }) {
  const shortContext = shortenShas(context);
  const diffBlock = diffContext
    ? `Diff (git show):\n${shortenShas(truncateText(diffContext, MAX_DIFF_CHARS))}`
    : "Diff: not available.";

  return `You are analyzing a SPECIFIC commit. Answer ONLY about this commit, not others.

Selected commit info:
${shortContext}

${diffBlock}

Answer the user's question about THIS commit only. Be concise and factual. Use short commit SHAs (7 chars).`;
}

async function readJsonResponse(res) {
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // ignore parse errors, return raw text for debugging
  }
  return { data, text };
}

async function callDirectLLM({ provider, apiKey, question, systemPrompt }) {
  const isAnthropic = provider === "anthropic";
  const url = isAnthropic ? ANTHROPIC_ENDPOINT : OPENAI_ENDPOINT;
  const headers = isAnthropic
    ? {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      }
    : {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
  const body = isAnthropic
    ? {
        model: "claude-3-haiku-20240307",
        max_tokens: 400,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }
    : {
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question },
        ],
      };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const { data, text } = await readJsonResponse(res);

  if (!res.ok) {
    const errorMessage = data?.error?.message || text || `LLM request failed (${res.status})`;
    throw new Error(errorMessage);
  }

  if (isAnthropic) {
    const message = data?.content?.[0]?.text;
    if (message) return message;
  } else {
    const message = data?.choices?.[0]?.message?.content;
    if (message) return message;
  }

  return text || "No response from model.";
}

function buildServer(options) {
  const app = express();
  const { memvid, outPath, cwd, apiKey, model, runCommand, runMode } = options;
  const runManager = new RunManager({ cwd, runCommand, runMode });

  app.use(express.json());

  const uiDir = path.join(__dirname, "ui");
  app.use("/", express.static(uiDir));

  app.get("/api/status", async (req, res) => {
    try {
      const stats = await memvid.withMemvid((mv) => mv.stats());
      res.json({
        path: outPath,
        stats,
        cwd,
        runCommand: runCommand || detectRunCommand(cwd),
        runMode: runMode || "auto",
      });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/timeline", async (req, res) => {
    const limit = Number(req.query.limit) || 100;
    try {
      const entries = await memvid.withMemvid((mv) => mv.timeline({ limit }));
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/view", async (req, res) => {
    const uri = req.query.uri;
    if (!uri) {
      res.status(400).json({ error: "missing uri" });
      return;
    }
    try {
      const text = await memvid.withMemvid((mv) => mv.viewByUri(uri));
      res.json({ text, parsed: parseCheckpointText(text) });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/find", async (req, res) => {
    const q = req.query.q;
    if (!q) {
      res.status(400).json({ error: "missing q" });
      return;
    }
    try {
      const result = await memvid.withMemvid((mv) => mv.find(q, { k: 20 }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post("/api/run", async (req, res) => {
    const { checkpointId } = req.body || {};
    if (!checkpointId) {
      res.status(400).json({ error: "missing checkpointId" });
      return;
    }

    try {
      const uri = `mv2://checkpoint/${checkpointId}`;
      const text = await memvid.withMemvid((mv) => mv.viewByUri(uri));
      const parsed = parseCheckpointText(text);
      const runInfo = await runManager.startRun({
        checkpointId,
        gitSha: parsed.gitSha,
        runCommand: parsed.runCommand || runCommand,
        runMode,
      });
      res.json(runInfo);
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/run/:runId/logs", (req, res) => {
    const { runId } = req.params;
    const since = req.query.since || 0;
    res.json(runManager.getLogs(runId, since));
  });

  app.get("/api/run/:runId/status", (req, res) => {
    const { runId } = req.params;
    res.json(runManager.getStatus(runId));
  });

  app.post("/api/run/:runId/stop", async (req, res) => {
    const { runId } = req.params;
    const stopped = await runManager.stopRun(runId);
    res.json({ stopped });
  });

  app.get("/api/blame", (req, res) => {
    const sha = req.query.sha;
    const file = req.query.file;
    if (!sha || !file) {
      res.status(400).json({ error: "missing sha or file" });
      return;
    }
    try {
      const output = execFileSync("git", ["blame", sha, "--", file], { cwd });
      const lines = output.toString().split("\n").slice(0, 200);
      res.json({ lines });
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  app.get("/api/diff", (req, res) => {
    const sha = req.query.sha;
    if (!sha) {
      res.status(400).json({ error: "missing sha" });
      return;
    }
    try {
      // Get the diff for this commit
      const diffOutput = execFileSync(
        "git",
        ["show", sha, "--format=", "--patch", "--stat"],
        { cwd, maxBuffer: 10 * 1024 * 1024 }
      );
      const diffText = diffOutput.toString();

      // Parse stats from --stat output
      const statsMatch = diffText.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      const stats = {
        files: statsMatch ? parseInt(statsMatch[1]) || 0 : 0,
        insertions: statsMatch ? parseInt(statsMatch[2]) || 0 : 0,
        deletions: statsMatch ? parseInt(statsMatch[3]) || 0 : 0,
      };

      // Extract just the diff portion (after the stat summary)
      const diffStartIdx = diffText.indexOf("diff --git");
      const diff = diffStartIdx > -1 ? diffText.slice(diffStartIdx) : diffText;

      res.json({ diff, stats });
    } catch (err) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // Chat status - check if AI is available
  app.get("/api/chat/status", (req, res) => {
    res.json({
      available: !!apiKey,
      model: model || "openai",
    });
  });

  // Ask endpoint - query the tape with AI
  app.post("/api/ask", async (req, res) => {
    const { question, checkpointId } = req.body || {};

    if (!question) {
      res.status(400).json({ error: "missing question" });
      return;
    }

    if (!apiKey) {
      res.status(400).json({ error: "AI not configured. Pass --api-key or set OPENAI_API_KEY env var." });
      return;
    }

    try {
      // Build context from checkpoint if provided
      let context = "";
      let diffContext = "";

      if (checkpointId) {
        const uri = `mv2://checkpoint/${checkpointId}`;
        let text = "";
        try {
          text = await memvid.withMemvid((mv) => mv.viewByUri(uri));
        } catch (err) {
          res.status(404).json({ error: "checkpoint not found" });
          return;
        }

        if (!text) {
          res.status(404).json({ error: "checkpoint not found" });
          return;
        }

        context = text;
        const parsed = parseCheckpointText(text);
        const sha = parsed.gitSha || checkpointId;

        if (sha) {
          try {
            const diffOutput = execFileSync(
              "git",
              ["show", sha, "--format=", "--patch"],
              { cwd, maxBuffer: 10 * 1024 * 1024 }
            );
            diffContext = diffOutput.toString();
          } catch (e) {
            // Diff not available
          }
        }

        const systemPrompt = buildCheckpointSystemPrompt({ context, diffContext });
        const answer = await callDirectLLM({
          provider: model === "anthropic" ? "anthropic" : "openai",
          apiKey,
          question,
          systemPrompt,
        });

        res.json({ answer });
        return;
      }

      // No checkpoint selected: use memvid's ask functionality across the tape
      const result = await memvid.withMemvid(async (mv) => {
        const modelConfig = model === "anthropic"
          ? { provider: "anthropic", apiKey, model: "claude-3-haiku-20240307" }
          : { provider: "openai", apiKey, model: "gpt-4o-mini" };

        const systemPrompt = "You are an AI assistant helping analyze code from a development session. Answer questions about the code changes. Be concise and helpful.";

        return mv.ask(question, {
          ...modelConfig,
          systemPrompt,
        });
      });

      const answer = typeof result === "string"
        ? result
        : result?.answer || result?.response || result?.text || result?.content || JSON.stringify(result, null, 2);

      res.json({ answer });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return app;
}

function startServer(options) {
  const app = buildServer(options);
  const requestedPort = Number.isFinite(options.port) ? options.port : null;
  const primaryPort = requestedPort || 23404;
  const fallbackPort = requestedPort ? null : 23405;

  const listen = (port, nextPort) => {
    const server = app.listen(port, "0.0.0.0", () => {
      info(`web: http://0.0.0.0:${port}`);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && nextPort) {
        warn(`port ${port} in use; trying ${nextPort}`);
        listen(nextPort, null);
        return;
      }
      warn(`web server failed: ${err.message || err}`);
      process.exit(1);
    });
  };

  listen(primaryPort, fallbackPort);

  process.on("SIGINT", async () => {
    warn("shutting down server");
    process.exit(0);
  });
}

module.exports = {
  startServer,
};
