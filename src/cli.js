const path = require("path");
const fs = require("fs");
const os = require("os");
const chokidar = require("chokidar");
const { buildMemvid } = require("./memvid");
const { TapeRecorder } = require("./tape");
const { isGitRepo, getHeadSha } = require("./git");
const { DEFAULT_IGNORES, shouldIgnore } = require("./files");
const { resolveRunCommand } = require("./run");
const { startServer } = require("./server");
const { info, warn, setVerbose } = require("./logger");

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Only set if not already set (env vars take precedence)
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    return true;
  } catch (err) {
    return false;
  }
}

function loadEnvFiles(cwd) {
  // Load in order of precedence (later files don't override earlier)
  // 1. Project .env (highest priority)
  const projectEnv = path.join(cwd, ".env");
  const loadedProject = loadEnvFile(projectEnv);

  // 2. Global ~/.commitreel/.env (fallback to legacy ~/.repltape/.env)
  const globalEnv = path.join(os.homedir(), ".commitreel", ".env");
  const legacyEnv = path.join(os.homedir(), ".repltape", ".env");
  const loadedGlobal = loadEnvFile(globalEnv);
  const loadedLegacy = loadedGlobal ? false : loadEnvFile(legacyEnv);

  if (loadedProject) {
    info(`loaded .env from ${projectEnv}`);
  } else if (loadedGlobal) {
    info(`loaded .env from ${globalEnv}`);
  } else if (loadedLegacy) {
    info(`loaded .env from ${legacyEnv}`);
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function showHelp() {
  console.log(`
commitreel

Usage:
  commitreel start [--out commitreel.tape.mv2] [--web] [--port 23404]
  commitreel checkpoint "message" [--out commitreel.tape.mv2]
  commitreel web [--out commitreel.tape.mv2] [--port 23404]

Options:
  --out PATH           Output tape file (default: commitreel.tape.mv2)
  --cwd PATH           Working directory (default: current directory)
  --web                Start web UI
  --port NUM           Web port (default: 23404)
  --interval SECONDS   Git polling interval (default: 5)
  --debounce MS        File checkpoint debounce (default: 4000)
  --capture-files      Store changed file snapshots in the tape
  --watch-files        Watch files even when git is available
  --no-seed            Skip initial baseline checkpoint
  --run CMD            Override run command used for checkpoints
  --run-mode MODE      Run mode: auto, web, cli (default: auto)
  --verbose            Verbose logs

AI Chat Options:
  --api-key KEY        API key for LLM
  --model MODEL        Model provider: openai, anthropic (default: openai)

Environment Variables:
  COMMITREEL_API_KEY   API key for AI chat (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
  COMMITREEL_MODEL     Model provider: openai, anthropic
  REPLTAPE_API_KEY     Legacy key (still supported)
  REPLTAPE_MODEL       Legacy model (still supported)

.env File Locations (in priority order):
  1. <cwd>/.env         Project-specific config
  2. ~/.commitreel/.env Global config
  3. ~/.repltape/.env   Legacy global config
`);
}

async function startTape(args) {
  const cwd = path.resolve(args.cwd || process.cwd());

  // Load .env files before accessing env vars
  loadEnvFiles(cwd);

  const outPath = path.resolve(args.out || "commitreel.tape.mv2");
  const interval = Number(args.interval) || 5;
  const debounceMs = Number(args.debounce) || 4000;

  const hasGit = isGitRepo(cwd);
  const captureFiles = args["capture-files"] ? true : !hasGit;
  const watchFiles = args["watch-files"] ? true : !hasGit;

  const runOverride = typeof args.run === "string" ? args.run : null;
  const runCommand = resolveRunCommand(cwd, runOverride);
  const runMode = typeof args["run-mode"] === "string" ? args["run-mode"] : "auto";
  const memvid = buildMemvid(outPath);
  const recorder = new TapeRecorder({
    cwd,
    runCommand,
    captureFiles,
    memvid,
  });

  info(`workspace: ${cwd}`);

  if (hasGit) {
    let lastSha = getHeadSha(cwd);
    info(`git detected: ${lastSha.slice(0, 7)}`);
    if (!args["no-seed"]) {
      await recorder.recordGitCheckpoint(null, lastSha, "Baseline");
    }
    setInterval(async () => {
      try {
        const sha = getHeadSha(cwd);
        if (sha !== lastSha) {
          const prev = lastSha;
          lastSha = sha;
          await recorder.recordGitCheckpoint(prev, sha, "Agent checkpoint");
        }
      } catch (err) {
        warn(`git watch error: ${err.message || err}`);
      }
    }, interval * 1000);
  } else {
    info("git not detected; using file snapshots");
  }

  if (watchFiles) {
    const pending = new Set();
    let timer = null;

    const watcher = chokidar.watch(cwd, {
      ignored: (filePath) => shouldIgnore(path.relative(cwd, filePath), DEFAULT_IGNORES),
      ignoreInitial: true,
      persistent: true,
    });

    const scheduleCheckpoint = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const files = Array.from(pending);
        pending.clear();
        if (!files.length) return;
        await recorder.recordFileCheckpoint("Auto checkpoint", files);
      }, debounceMs);
    };

    watcher.on("change", (filePath) => {
      const rel = path.relative(cwd, filePath);
      pending.add(rel);
      scheduleCheckpoint();
    });

    watcher.on("add", (filePath) => {
      const rel = path.relative(cwd, filePath);
      pending.add(rel);
      scheduleCheckpoint();
    });
  }

  if (args.web) {
    startServer({
      memvid,
      outPath,
      port: Number(args.port) || 23404,
      cwd,
      runCommand,
      runMode,
      apiKey: args["api-key"] || process.env.COMMITREEL_API_KEY || process.env.REPLTAPE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
      model: args.model || process.env.COMMITREEL_MODEL || process.env.REPLTAPE_MODEL || "openai",
    });
  }

  info(`recording to ${outPath}`);
}

async function checkpointTape(args) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const outPath = path.resolve(args.out || "commitreel.tape.mv2");
  const message = args._.slice(1).join(" ") || "Manual checkpoint";
  const runOverride = typeof args.run === "string" ? args.run : null;
  const runCommand = resolveRunCommand(cwd, runOverride);

  const memvid = buildMemvid(outPath);
  const recorder = new TapeRecorder({
    cwd,
    runCommand,
    captureFiles: true,
    memvid,
  });
  await recorder.recordManualCheckpoint(message);
  await memvid.close();
}

async function webTape(args) {
  const cwd = path.resolve(args.cwd || process.cwd());

  // Load .env files before accessing env vars
  loadEnvFiles(cwd);

  const outPath = path.resolve(args.out || "commitreel.tape.mv2");
  const runOverride = typeof args.run === "string" ? args.run : null;
  const runCommand = resolveRunCommand(cwd, runOverride);
  const runMode = typeof args["run-mode"] === "string" ? args["run-mode"] : "auto";
  const memvid = buildMemvid(outPath);
  startServer({
    memvid,
    outPath,
    port: Number(args.port) || 23404,
    cwd,
    runCommand,
    runMode,
    apiKey: args["api-key"] || process.env.COMMITREEL_API_KEY || process.env.REPLTAPE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
    model: args.model || process.env.COMMITREEL_MODEL || process.env.REPLTAPE_MODEL || "openai",
  });
}

async function runCli(argv) {
  const args = parseArgs(argv);
  setVerbose(Boolean(args.verbose));
  const command = args._[0];

  if (!command || command === "help" || command === "-h" || command === "--help") {
    showHelp();
    return;
  }

  if (command === "start") {
    await startTape(args);
    return;
  }

  if (command === "checkpoint") {
    await checkpointTape(args);
    return;
  }

  if (command === "web") {
    await webTape(args);
    return;
  }

  showHelp();
}

module.exports = {
  runCli,
};
