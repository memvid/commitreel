const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_IGNORES = [
  ".git",
  ".repl-tape",
  ".commitreel",
  "node_modules",
  ".cache",
  ".npm",
  ".mv2",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
];

function shouldIgnore(filePath, ignores) {
  return ignores.some((entry) => filePath.includes(entry));
}

function listFiles(root, ignores = DEFAULT_IGNORES) {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);
      if (shouldIgnore(relPath, ignores)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  }
  walk(root);
  return results;
}

function readFileSnapshot(root, relPath) {
  const fullPath = path.join(root, relPath);
  const content = fs.readFileSync(fullPath, "utf8");
  const hash = crypto.createHash("sha1").update(content).digest("hex");
  return { relPath, content, hash, size: content.length };
}

module.exports = {
  DEFAULT_IGNORES,
  listFiles,
  readFileSnapshot,
  shouldIgnore,
};
