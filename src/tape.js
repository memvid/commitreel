const crypto = require("crypto");
const { info, warn } = require("./logger");
const {
  isGitRepo,
  getHeadSha,
  getCommitMessage,
  getCommitTimestamp,
  getDiffStat,
  getChangedFiles,
  getFileAtCommit,
} = require("./git");
const { listFiles, readFileSnapshot } = require("./files");

function newCheckpointId() {
  return crypto.randomUUID();
}

function formatCheckpointText(data) {
  const lines = [
    `Checkpoint: ${data.title}`,
    `ID: ${data.id}`,
    `Source: ${data.source}`,
  ];

  if (data.gitSha) {
    lines.push(`Git: ${data.gitSha}`);
  }
  if (data.gitMessage) {
    lines.push(`Message: ${data.gitMessage}`);
  }
  if (data.diffSummary) {
    lines.push(`Diff: ${data.diffSummary}`);
  }
  if (data.files && data.files.length) {
    lines.push(`Files: ${data.files.join(", ")}`);
  }
  if (data.runCommand) {
    lines.push(`Run: ${data.runCommand}`);
  }
  if (data.note) {
    lines.push(`Note: ${data.note}`);
  }

  return lines.join("\n");
}

async function recordCheckpoint(mv, data) {
  const text = formatCheckpointText(data);
  const uri = `mv2://checkpoint/${data.id}`;
  await mv.put({
    title: data.title,
    label: "checkpoint",
    uri,
    text,
    metadata: {
      checkpoint_id: data.id,
      source: data.source,
      git_sha: data.gitSha,
      git_message: data.gitMessage,
      diff_summary: data.diffSummary,
      files: data.files || [],
      run_command: data.runCommand,
      timestamp: data.timestamp,
    },
  });

  return { id: data.id, uri };
}

async function recordFileSnapshot(mv, checkpointId, snapshot) {
  const uri = `mv2://file/${encodeURIComponent(snapshot.relPath)}#${checkpointId}`;
  const title = `File: ${snapshot.relPath}`;
  const text = snapshot.content;
  await mv.put({
    title,
    label: "file-snapshot",
    uri,
    text,
    metadata: {
      checkpoint_id: checkpointId,
      path: snapshot.relPath,
      hash: snapshot.hash,
      size: snapshot.size,
    },
  });
}

class TapeRecorder {
  constructor(options) {
    this.cwd = options.cwd;
    this.runCommand = options.runCommand;
    this.captureFiles = options.captureFiles;
    this.memvid = options.memvid;
  }

  async recordGitCheckpoint(prevSha, nextSha, note) {
    const gitMessage = getCommitMessage(nextSha, this.cwd);
    const gitTimestamp = getCommitTimestamp(nextSha, this.cwd);
    const diff = getDiffStat(prevSha, nextSha, this.cwd);
    const files = getChangedFiles(prevSha, nextSha, this.cwd);
    const checkpointId = nextSha;
    const title = gitMessage || `Checkpoint ${checkpointId.slice(0, 7)}`;

    const exists = await this.memvid.withMemvid(async (mv) => {
      try {
        await mv.viewByUri(`mv2://checkpoint/${checkpointId}`);
        return true;
      } catch (_) {
        return false;
      }
    });

    if (exists) {
      info(`checkpoint already recorded: ${checkpointId.slice(0, 7)}`);
      return { id: checkpointId, uri: `mv2://checkpoint/${checkpointId}`, skipped: true };
    }

    const checkpoint = await this.memvid.withMemvid((mv) =>
      recordCheckpoint(mv, {
        id: checkpointId,
        title,
        source: "git",
        gitSha: nextSha,
        gitMessage,
        diffSummary: diff.summary,
        files,
        runCommand: this.runCommand,
        note,
        timestamp: gitTimestamp,
      })
    );

    if (this.captureFiles && files.length) {
      await this.memvid.withMemvid(async (mv) => {
        for (const file of files) {
          try {
            const content = getFileAtCommit(nextSha, file, this.cwd);
            const snapshot = {
              relPath: file,
              content,
              hash: crypto.createHash("sha1").update(content).digest("hex"),
              size: content.length,
            };
            await recordFileSnapshot(mv, checkpointId, snapshot);
          } catch (err) {
            warn(`failed to snapshot ${file}: ${err.message || err}`);
          }
        }
      });
    }

    info(`checkpoint recorded: ${checkpointId.slice(0, 7)} ${title}`);
    return checkpoint;
  }

  async recordFileCheckpoint(note, changedFiles) {
    const checkpointId = newCheckpointId();
    const title = note || `Checkpoint ${checkpointId.slice(0, 8)}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const checkpoint = await this.memvid.withMemvid((mv) =>
      recordCheckpoint(mv, {
        id: checkpointId,
        title,
        source: "files",
        diffSummary: "",
        files: changedFiles,
        runCommand: this.runCommand,
        note,
        timestamp,
      })
    );

    if (this.captureFiles && changedFiles.length) {
      await this.memvid.withMemvid(async (mv) => {
        for (const file of changedFiles) {
          try {
            const snapshot = readFileSnapshot(this.cwd, file);
            await recordFileSnapshot(mv, checkpointId, snapshot);
          } catch (err) {
            warn(`failed to snapshot ${file}: ${err.message || err}`);
          }
        }
      });
    }

    info(`checkpoint recorded: ${checkpointId.slice(0, 7)} ${title}`);
    return checkpoint;
  }

  async recordManualCheckpoint(note) {
    if (isGitRepo(this.cwd)) {
      const sha = getHeadSha(this.cwd);
      return this.recordGitCheckpoint(null, sha, note || "Manual checkpoint");
    }

    const files = listFiles(this.cwd);
    return this.recordFileCheckpoint(note || "Manual checkpoint", files);
  }
}

module.exports = {
  TapeRecorder,
};
