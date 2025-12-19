const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, execSync } = require("child_process");
const { info, warn } = require("./logger");
const { isGitRepo } = require("./git");

function detectRunCommand(workdir) {
  const replPath = path.join(workdir, ".replit");
  if (fs.existsSync(replPath)) {
    const replText = fs.readFileSync(replPath, "utf8");
    const match =
      replText.match(/run\s*=\s*"([^"]+)"/) ||
      replText.match(/run\s*=\s*'([^']+)'/) ||
      replText.match(/run\s*=\s*([^\n]+)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  const pkgPath = path.join(workdir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const scripts = pkg.scripts || {};
      if (scripts.dev) return "npm run dev";
      if (scripts.start) return "npm start";
      if (scripts.preview) return "npm run preview";
    } catch (err) {
      warn("failed to parse package.json");
    }
  }

  const fallback = ["index.js", "server.js", "main.py", "app.py"].find((file) =>
    fs.existsSync(path.join(workdir, file))
  );
  if (fallback) {
    return fallback.endsWith(".py") ? `python ${fallback}` : `node ${fallback}`;
  }

  return null;
}

function resolveRunCommand(workdir, override) {
  if (override) return override;
  return detectRunCommand(workdir);
}

function normalizeRunMode(value) {
  if (!value) return "auto";
  const mode = String(value).toLowerCase();
  if (mode === "web" || mode === "cli" || mode === "auto") return mode;
  return "auto";
}

function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return "";
  }
}

function textHasAny(text, tokens) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

function hasWebDeps(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const names = Object.keys(deps).map((name) => name.toLowerCase());
  const webDeps = [
    "next",
    "react",
    "react-dom",
    "react-scripts",
    "vite",
    "svelte",
    "astro",
    "nuxt",
    "@remix-run/dev",
    "gatsby",
    "express",
    "fastify",
    "koa",
    "hono",
    "nestjs",
    "angular",
  ];
  return names.some((name) => webDeps.includes(name));
}

function detectRunMode(workdir, runCommand, override) {
  const mode = normalizeRunMode(override);
  if (mode !== "auto") return mode;

  const replText = readTextIfExists(path.join(workdir, ".replit"));
  if (replText) return "web";

  const pkgPath = path.join(workdir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (hasWebDeps(pkg)) return "web";
    } catch (err) {
      // ignore parse errors
    }
  }

  const requirementsText = readTextIfExists(path.join(workdir, "requirements.txt"));
  const pyprojectText = readTextIfExists(path.join(workdir, "pyproject.toml"));
  const webPy = [
    "flask",
    "fastapi",
    "django",
    "uvicorn",
    "gunicorn",
    "starlette",
    "bottle",
    "falcon",
    "aiohttp",
    "tornado",
  ];
  if (textHasAny(requirementsText, webPy) || textHasAny(pyprojectText, webPy)) {
    return "web";
  }

  const cmd = (runCommand || "").toLowerCase();
  if (textHasAny(cmd, [
    "next",
    "vite",
    "react-scripts",
    "nuxt",
    "svelte",
    "astro",
    "remix",
    "gatsby",
    "ng serve",
    "webpack",
    "parcel",
    "serve",
    "flask",
    "django",
    "uvicorn",
    "gunicorn",
    "fastapi",
    "starlette",
    "rails",
    "phoenix",
  ])) {
    return "web";
  }

  if (cmd.includes("server.js") || cmd.includes("app.js") || cmd.includes("main.py") || cmd.includes("app.py")) {
    return "web";
  }

  return "cli";
}

function validatePackageJson(workdir, runCommand) {
  const pkgPath = path.join(workdir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const isNodeCommand = /(^|\s)(node|npm|pnpm|yarn|bun|npx)\b/.test(runCommand || "");
  if (!isNodeCommand) return null;
  try {
    JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return null;
  } catch (err) {
    return `Invalid package.json in checkpoint: ${pkgPath}`;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function gitWorktreeAdd(cwd, sha, target) {
  if (fs.existsSync(target)) {
    try {
      gitWorktreeRemove(cwd, target);
    } catch (_) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  execSync(`git worktree add ${target} ${sha}`, { cwd, stdio: "ignore" });
}

function gitWorktreeRemove(cwd, target) {
  execSync(`git worktree remove --force ${target}`, { cwd, stdio: "ignore" });
}

class RunManager {
  constructor(options) {
    this.cwd = options.cwd;
    this.runCommand = options.runCommand || null;
    this.runMode = normalizeRunMode(options.runMode);
    this.baseDir = path.join(this.cwd, ".commitreel", "run");
    this.active = null;
    this.logs = new Map();
    this.meta = new Map();
  }

  async startRun({ checkpointId, gitSha, runCommand, runMode }) {
    if (!isGitRepo(this.cwd)) {
      throw new Error("git repository not detected");
    }
    if (!gitSha) {
      throw new Error("checkpoint does not include git sha");
    }

    if (this.active) {
      await this.stopRun(this.active.runId);
    }

    ensureDir(this.baseDir);
    const workdir = path.join(this.baseDir, checkpointId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    gitWorktreeAdd(this.cwd, gitSha, workdir);

    const resolvedCommand = resolveRunCommand(workdir, runCommand || this.runCommand);
    if (!resolvedCommand) {
      gitWorktreeRemove(this.cwd, workdir);
      throw new Error("no run command detected in checkpoint");
    }

    const pkgError = validatePackageJson(workdir, resolvedCommand);
    if (pkgError) {
      gitWorktreeRemove(this.cwd, workdir);
      throw new Error(pkgError);
    }

    const resolvedMode = detectRunMode(workdir, resolvedCommand, runMode || this.runMode);
    const port = resolvedMode === "web" ? await getFreePort() : null;
    const runId = `${checkpointId}-${Date.now()}`;
    const env = resolvedMode === "web"
      ? { ...process.env, PORT: String(port) }
      : { ...process.env };
    const child = spawn(resolvedCommand, {
      cwd: workdir,
      env,
      shell: true,
    });

    const meta = {
      runId,
      checkpointId,
      gitSha,
      command: resolvedCommand,
      mode: resolvedMode,
      status: "running",
      port,
      previewUrl: resolvedMode === "web" ? `http://0.0.0.0:${port}` : null,
      startedAt: Date.now(),
    };

    const buffer = [];
    const pushLine = (line) => {
      buffer.push(line);
      if (buffer.length > 1000) buffer.shift();
    };

    child.stdout.on("data", (data) => pushLine(data.toString()));
    child.stderr.on("data", (data) => pushLine(data.toString()));

    child.on("exit", () => {
      info(`run exited for ${checkpointId}`);
    });

    this.logs.set(runId, buffer);
    this.meta.set(runId, meta);
    child.on("exit", (code, signal) => {
      meta.status = "exited";
      meta.exitCode = code;
      meta.signal = signal;
      meta.endedAt = Date.now();
    });

    this.active = { runId, checkpointId, gitSha, child, workdir, port };

    return {
      runId,
      port,
      previewUrl: meta.previewUrl,
      command: resolvedCommand,
      mode: resolvedMode,
    };
  }

  getLogs(runId, since = 0) {
    const buffer = this.logs.get(runId) || [];
    const start = Math.max(0, Number(since) || 0);
    const lines = buffer.slice(start);
    return { lines, next: buffer.length };
  }

  getStatus(runId) {
    return this.meta.get(runId) || { status: "unknown" };
  }

  async stopRun(runId) {
    if (!this.active || this.active.runId !== runId) {
      return false;
    }
    const { child, workdir } = this.active;
    child.kill("SIGTERM");
    const meta = this.meta.get(runId);
    if (meta) {
      meta.status = "stopped";
      meta.endedAt = Date.now();
    }
    try {
      gitWorktreeRemove(this.cwd, workdir);
    } catch (err) {
      warn("failed to remove worktree");
    }
    this.active = null;
    return true;
  }
}

module.exports = {
  RunManager,
  detectRunCommand,
  resolveRunCommand,
};
