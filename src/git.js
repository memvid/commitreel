const { execSync } = require("child_process");

function runGit(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function isGitRepo(cwd) {
  try {
    const out = runGit("rev-parse --is-inside-work-tree", cwd);
    return out === "true";
  } catch {
    return false;
  }
}

function getHeadSha(cwd) {
  return runGit("rev-parse HEAD", cwd);
}

function getCommitMessage(sha, cwd) {
  return runGit(`show -s --format=%s ${sha}`, cwd);
}

function getCommitTimestamp(sha, cwd) {
  const ts = runGit(`show -s --format=%ct ${sha}`, cwd);
  return parseInt(ts, 10);
}

function getDiffStat(prev, next, cwd) {
  if (!prev || prev === next) {
    return { summary: "", files: [] };
  }
  const stat = runGit(`diff --stat --no-color ${prev} ${next}`, cwd);
  const lines = stat.split("\n").filter(Boolean);
  const summary = lines[lines.length - 1] || "";
  const files = lines.slice(0, Math.max(0, lines.length - 1)).map((line) => {
    const [filePart] = line.split("|");
    return filePart.trim();
  });
  return { summary, files };
}

function getChangedFiles(prev, next, cwd) {
  if (!prev || prev === next) {
    return [];
  }
  const out = runGit(`diff --name-only ${prev} ${next}`, cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

function getFileAtCommit(sha, filePath, cwd) {
  return runGit(`show ${sha}:${filePath}`, cwd);
}

function getRecentCommits(limit, cwd) {
  const out = runGit(`log -n ${limit} --format=%H`, cwd);
  return out.split("\n").filter(Boolean);
}

module.exports = {
  isGitRepo,
  getHeadSha,
  getCommitMessage,
  getCommitTimestamp,
  getDiffStat,
  getChangedFiles,
  getFileAtCommit,
  getRecentCommits,
};
