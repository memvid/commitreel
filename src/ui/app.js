/**
 * COMMITREEL — Graphite-inspired UI
 */

// DOM Elements
const inspectorContent = document.getElementById("inspector-content");
const checkpointIdEl = document.getElementById("checkpoint-id");
const runBtn = document.getElementById("run-btn");
const logsEl = document.getElementById("logs");
const stderrEl = document.getElementById("stderr");
const logCountEl = document.getElementById("log-count");
const diffHeader = document.getElementById("diff-header");
const diffContent = document.getElementById("diff-content");
const filesListEl = document.getElementById("files-list");
const fileCountEl = document.getElementById("file-count");
const blameFileEl = document.getElementById("blame-file");
const blameLinesEl = document.getElementById("blame-lines");
const blameContentEl = document.getElementById("blame-content");
const timelineEl = document.getElementById("timeline");
const searchEl = document.getElementById("search");
const currentFrameEl = document.getElementById("current-frame");
const totalFramesEl = document.getElementById("total-frames");
const frameCountEl = document.getElementById("frame-count");
const tapeNameEl = document.getElementById("tape-name");

// Transport
const btnPrev = document.getElementById("btn-prev");
const btnPlay = document.getElementById("btn-play");
const btnStop = document.getElementById("btn-stop");
const btnNext = document.getElementById("btn-next");

// Assistant
const assistantDrawer = document.getElementById("assistant-drawer");
const drawerOverlay = document.getElementById("drawer-overlay");
const btnAssistant = document.getElementById("btn-assistant");
const closeDrawer = document.getElementById("close-drawer");
const assistantContext = document.getElementById("assistant-context");
const assistantMessages = document.getElementById("assistant-messages");
const assistantInput = document.getElementById("assistant-input");
const assistantSend = document.getElementById("assistant-send");

// State
let timelineEntries = [];
let activeEntry = null;
let activeCard = null;
let currentIndex = -1;
let activeRun = null;
let logCursor = 0;
let logTimer = null;
let statusTimer = null;
let assistantAvailable = false;
const SELECTION_STORAGE_KEY = "commitreel:selectedCheckpoint";

// ============================================
// Utilities
// ============================================

function formatTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function parsePreview(entry) {
  if (!entry.preview) return { title: entry.uri || "Checkpoint" };
  const data = {};
  entry.preview.split("\n").forEach(line => {
    const [key, ...rest] = line.split(":");
    if (!key || !rest.length) return;
    const value = rest.join(":").trim();
    switch (key.trim()) {
      case "Checkpoint": data.title = value; break;
      case "ID": data.id = value; break;
      case "Git": data.gitSha = value; break;
      case "Message": data.message = value; break;
      case "Diff": data.diff = value; break;
      case "Files": data.files = value.split(",").map(v => v.trim()).filter(Boolean); break;
      case "Source": data.source = value; break;
    }
  });
  return data;
}

function getCheckpointIdFromUri(uri) {
  if (!uri) return null;
  const prefix = "mv2://checkpoint/";
  if (uri.startsWith(prefix)) return uri.slice(prefix.length);
  return uri;
}

function resolveCheckpointId(entry) {
  if (!entry) return null;
  const fromUri = getCheckpointIdFromUri(entry.uri);
  if (fromUri) return fromUri;
  const meta = parsePreview(entry);
  return meta.id || null;
}

function getCheckpointIdFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  if (hash.startsWith("checkpoint=")) {
    return decodeURIComponent(hash.slice("checkpoint=".length));
  }
  return decodeURIComponent(hash);
}

function getPreferredCheckpointId() {
  const fromHash = getCheckpointIdFromHash();
  if (fromHash) return fromHash;
  try {
    return localStorage.getItem(SELECTION_STORAGE_KEY);
  } catch (err) {
    return null;
  }
}

function setPreferredCheckpointId(id) {
  if (!id) return;
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, id);
  } catch (err) {
    // ignore storage failures
  }
  const nextHash = `#checkpoint=${encodeURIComponent(id)}`;
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, "", nextHash);
  }
}

function restoreSelection(entries, options = {}) {
  if (!entries.length) return;
  const activeId = resolveCheckpointId(activeEntry);
  const preferredId = options.preferStored ? getPreferredCheckpointId() : null;
  const targetId = activeId || preferredId;
  let index = targetId
    ? entries.findIndex((entry) => resolveCheckpointId(entry) === targetId)
    : -1;
  if (index === -1 && options.allowFirst) index = 0;
  if (index < 0) return;
  const card = timelineEl.querySelector(`[data-index="${index}"]`);
  if (card) selectEntry(entries[index], card, index);
}

// ============================================
// Status
// ============================================

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (tapeNameEl) tapeNameEl.textContent = data.path?.split("/").pop() || "tape.mv2";
    if (frameCountEl) frameCountEl.textContent = data.stats?.frame_count || 0;
  } catch (e) {
    console.error("Failed to load status:", e);
  }
}

// ============================================
// Timeline
// ============================================

async function loadTimeline() {
  const res = await fetch("/api/timeline");
  const data = await res.json();
  timelineEntries = (data.entries || []).filter(e => e.uri?.startsWith("mv2://checkpoint/"));
  renderTimeline(timelineEntries);
  restoreSelection(timelineEntries, { preferStored: true, allowFirst: true });
  updateCounter();
}

function renderTimeline(entries) {
  timelineEl.innerHTML = '<div class="playhead" id="playhead"></div>';

  if (!entries.length) {
    timelineEl.innerHTML += '<div style="padding: 16px; color: var(--text-muted);">No checkpoints yet</div>';
    return;
  }

  entries.forEach((entry, i) => {
    const meta = parsePreview(entry);
    const card = document.createElement("div");
    card.className = "timeline-card";
    card.dataset.index = i;
    card.innerHTML = `
      <div class="card-index">#${i + 1}</div>
      <div class="card-title">${meta.title || "Checkpoint"}</div>
      <div class="card-meta">
        <span class="card-sha">${meta.gitSha?.slice(0, 7) || "—"}</span>
        <span class="card-time">${formatTime(entry.timestamp)}</span>
      </div>
    `;
    card.addEventListener("click", () => selectEntry(entry, card, i));
    timelineEl.appendChild(card);
  });

  if (totalFramesEl) totalFramesEl.textContent = entries.length;
}

function updateCounter() {
  if (currentFrameEl) currentFrameEl.textContent = currentIndex >= 0 ? currentIndex + 1 : 0;
  if (totalFramesEl) totalFramesEl.textContent = timelineEntries.length;
}

function positionPlayhead(card) {
  const playhead = document.getElementById("playhead");
  if (!playhead || !card) return;
  const rect = card.getBoundingClientRect();
  const trackRect = timelineEl.getBoundingClientRect();
  playhead.style.left = `${rect.left - trackRect.left + rect.width / 2 + timelineEl.scrollLeft}px`;
}

// ============================================
// Selection
// ============================================

async function selectEntry(entry, card, index) {
  document.querySelectorAll(".timeline-card").forEach(c => {
    c.classList.remove("active");
    c.classList.remove("failed"); // Clear failed state when selecting new checkpoint
  });
  card.classList.add("active");
  activeCard = card;
  currentIndex = index;
  updateCounter();
  positionPlayhead(card);
  card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });

  const res = await fetch(`/api/view?uri=${encodeURIComponent(entry.uri)}`);
  const data = await res.json();

  if (data.error) {
    inspectorContent.innerHTML = `<div class="empty-state"><p class="empty-text">${data.error}</p></div>`;
    return;
  }

  activeEntry = { ...entry, parsed: data.parsed };
  setPreferredCheckpointId(resolveCheckpointId(entry));
  if (checkpointIdEl) checkpointIdEl.textContent = `#${index + 1}`;
  runBtn.disabled = !data.parsed?.gitSha;

  renderInspector(data.parsed, entry);

  if (data.parsed?.gitSha) {
    loadDiff(data.parsed.gitSha);
  }

  updateAssistantContext();
}

function renderInspector(parsed, entry) {
  const files = parsed.files || [];
  let insertions = 0, deletions = 0;

  if (parsed.diff) {
    const match = parsed.diff.match(/(\d+) insertion.*?(\d+) deletion/);
    if (match) {
      insertions = parseInt(match[1]) || 0;
      deletions = parseInt(match[2]) || 0;
    }
  }

  inspectorContent.innerHTML = `
    <div class="checkpoint-detail">
      <h3 class="checkpoint-title">${parsed.title || "Checkpoint"}</h3>
      ${parsed.message ? `<p class="checkpoint-message">${parsed.message}</p>` : ""}

      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">Source</div>
          <div class="stat-value">${parsed.source || "git"}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">SHA</div>
          <div class="stat-value mono">${parsed.gitSha?.slice(0, 8) || "—"}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Added</div>
          <div class="stat-value success">+${insertions}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Removed</div>
          <div class="stat-value error">-${deletions}</div>
        </div>
      </div>
    </div>
  `;

  // Update files panel
  if (fileCountEl) fileCountEl.textContent = `${files.length} files`;

  if (files.length) {
    filesListEl.innerHTML = files.map(f => `
      <button class="file-chip" data-file="${f}" title="${f}">${f.split("/").pop()}</button>
    `).join("");

    filesListEl.querySelectorAll(".file-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        if (parsed.gitSha) loadBlame(parsed.gitSha, chip.dataset.file, chip);
      });
    });
  } else {
    filesListEl.innerHTML = '<div class="empty-state small"><p class="empty-text">No files changed</p></div>';
  }
}

// ============================================
// Diff
// ============================================

async function loadDiff(sha) {
  switchTab("diff");
  diffHeader.innerHTML = `<span class="diff-sha">${sha.slice(0, 8)}</span> <span style="color: var(--text-muted)">Loading...</span>`;
  diffContent.innerHTML = "";

  try {
    const res = await fetch(`/api/diff?sha=${encodeURIComponent(sha)}`);
    const data = await res.json();

    if (data.error) {
      diffHeader.innerHTML = `<span style="color: var(--text-muted)">${data.error}</span>`;
      return;
    }

    const stats = data.stats || {};
    diffHeader.innerHTML = `
      <span class="diff-sha">${sha.slice(0, 8)}</span>
      <div class="diff-stats">
        <span class="diff-stat-add">+${stats.insertions || 0}</span>
        <span class="diff-stat-del">-${stats.deletions || 0}</span>
        <span class="diff-stat-files">${stats.files || 0} files</span>
      </div>
    `;

    if (data.diff) {
      diffContent.innerHTML = highlightDiff(data.diff);
      const files = extractFiles(data.diff);
      if (files.length) updateFilesFromDiff(sha, files);
    }
  } catch (err) {
    diffHeader.innerHTML = `<span style="color: var(--error)">${err.message}</span>`;
  }
}

function extractFiles(diff) {
  const files = [];
  const re = /^diff --git a\/(.+?) b\//gm;
  let m;
  while ((m = re.exec(diff))) files.push(m[1]);
  return [...new Set(files)];
}

function updateFilesFromDiff(sha, files) {
  if (fileCountEl) fileCountEl.textContent = `${files.length} files`;
  filesListEl.innerHTML = files.map(f => `
    <button class="file-chip" data-file="${f}" title="${f}">${f.split("/").pop()}</button>
  `).join("");

  filesListEl.querySelectorAll(".file-chip").forEach(chip => {
    chip.addEventListener("click", () => loadBlame(sha, chip.dataset.file, chip));
  });
}

function highlightDiff(text) {
  return text.split("\n").map(line => {
    let cls = "diff-line";
    if (line.startsWith("+++") || line.startsWith("---")) cls += " diff-line-file";
    else if (line.startsWith("@@")) cls += " diff-line-hunk";
    else if (line.startsWith("+")) cls += " diff-line-add";
    else if (line.startsWith("-")) cls += " diff-line-del";
    else if (line.startsWith("diff ") || line.startsWith("index ")) cls += " diff-line-meta";
    return `<span class="${cls}">${line.replace(/</g, "&lt;")}</span>`;
  }).join("\n");
}

// ============================================
// Blame
// ============================================

async function loadBlame(sha, file, chip) {
  if (chip) {
    document.querySelectorAll(".file-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
  }

  if (blameFileEl) blameFileEl.textContent = file;
  if (blameContentEl) blameContentEl.textContent = "Loading...";

  try {
    const res = await fetch(`/api/blame?sha=${encodeURIComponent(sha)}&file=${encodeURIComponent(file)}`);
    const data = await res.json();

    if (data.error) {
      if (blameContentEl) blameContentEl.textContent = data.error;
      if (blameLinesEl) blameLinesEl.textContent = "0 lines";
      return;
    }

    if (blameContentEl) blameContentEl.textContent = data.lines.join("\n");
    if (blameLinesEl) blameLinesEl.textContent = `${data.lines.length} lines`;
  } catch (err) {
    if (blameContentEl) blameContentEl.textContent = err.message;
  }
}

// ============================================
// Tabs
// ============================================

function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === `tab-${name}`));
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

// ============================================
// Run
// ============================================

async function runCheckpoint() {
  if (!activeEntry) return;

  runBtn.disabled = true;
  logsEl.innerHTML = "";
  logCursor = 0;
  switchTab("stdout");

  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkpointId: activeEntry.parsed?.id }),
  });

  const data = await res.json();
  if (data.error) {
    logsEl.innerHTML = `<span style="color: var(--error)">${data.error}</span>`;
    runBtn.disabled = false;
    return;
  }

  activeRun = data;

  // Show run info with clickable preview URL
  const runInfo = document.createElement("div");
  runInfo.className = "run-info";
  runInfo.innerHTML = `
    <div class="run-info-row">
      <span class="run-info-label">Command:</span>
      <code class="run-info-value">${data.command || "—"}</code>
    </div>
    ${data.mode ? `
    <div class="run-info-row">
      <span class="run-info-label">Mode:</span>
      <span class="run-info-muted">${data.mode.toUpperCase()}</span>
    </div>
    ` : ""}
    ${data.previewUrl ? `
    <div class="run-info-row">
      <span class="run-info-label">Preview:</span>
      <a href="${data.previewUrl}" target="_blank" class="run-info-link">${data.previewUrl}</a>
    </div>
    ` : `
    <div class="run-info-row">
      <span class="run-info-label">Preview:</span>
      <span class="run-info-muted">No web preview (CLI run)</span>
    </div>
    `}
  `;
  logsEl.appendChild(runInfo);

  if (logTimer) clearInterval(logTimer);
  if (statusTimer) clearInterval(statusTimer);
  logTimer = setInterval(fetchLogs, 1000);
  statusTimer = setInterval(fetchStatus, 1200);
}

async function fetchLogs() {
  if (!activeRun) return;
  const res = await fetch(`/api/run/${activeRun.runId}/logs?since=${logCursor}`);
  const data = await res.json();

  if (data.lines?.length) {
    const placeholder = logsEl.querySelector(".log-placeholder");
    if (placeholder) placeholder.remove();

    data.lines.forEach(line => {
      const span = document.createElement("span");
      span.className = "log-line new";
      span.textContent = line;
      logsEl.appendChild(span);
    });
    logsEl.scrollTop = logsEl.scrollHeight;

    if (logCountEl) logCountEl.textContent = `${logsEl.querySelectorAll(".log-line").length} lines`;
  }
  logCursor = data.next || logCursor;
}

async function fetchStatus() {
  if (!activeRun) return;
  const res = await fetch(`/api/run/${activeRun.runId}/status`);
  const data = await res.json();

  if (data.status === "exited") {
    if (data.exitCode && data.exitCode !== 0) {
      if (activeCard) activeCard.classList.add("failed");
    }
    runBtn.disabled = false;
    clearInterval(statusTimer);
  }
}

async function stopRun() {
  if (!activeRun) return;
  await fetch(`/api/run/${activeRun.runId}/stop`, { method: "POST" });
  activeRun = null;
  runBtn.disabled = false;
  if (logTimer) clearInterval(logTimer);
  if (statusTimer) clearInterval(statusTimer);
}

// ============================================
// Navigation
// ============================================

function navigatePrev() {
  if (currentIndex > 0) {
    const card = timelineEl.querySelector(`[data-index="${currentIndex - 1}"]`);
    if (card) selectEntry(timelineEntries[currentIndex - 1], card, currentIndex - 1);
  }
}

function navigateNext() {
  if (currentIndex < timelineEntries.length - 1) {
    const card = timelineEl.querySelector(`[data-index="${currentIndex + 1}"]`);
    if (card) selectEntry(timelineEntries[currentIndex + 1], card, currentIndex + 1);
  }
}

// ============================================
// Assistant
// ============================================

function openAssistant() {
  assistantDrawer.classList.add("open");
  drawerOverlay.classList.add("open");
  assistantInput?.focus();
}

function closeAssistantDrawer() {
  assistantDrawer.classList.remove("open");
  drawerOverlay.classList.remove("open");
}

async function checkAssistantStatus() {
  try {
    const res = await fetch("/api/chat/status");
    const data = await res.json();
    assistantAvailable = data.available;

    if (!assistantAvailable) {
      assistantMessages.innerHTML = `
        <div class="assistant-welcome">
          <p>AI not configured. Use <code>--api-key</code> to enable.</p>
        </div>
      `;
      if (assistantInput) assistantInput.disabled = true;
      if (assistantSend) assistantSend.disabled = true;
    }
  } catch (e) {
    console.error("Failed to check assistant:", e);
  }
}

function updateAssistantContext() {
  if (!assistantContext) return;
  assistantContext.innerHTML = '<option value="">All checkpoints</option>';

  timelineEntries.forEach((entry, i) => {
    const meta = parsePreview(entry);
    const opt = document.createElement("option");
    opt.value = meta.id || meta.gitSha || "";
    opt.textContent = `#${i + 1}: ${meta.title || "Checkpoint"}`;
    assistantContext.appendChild(opt);
  });

  if (activeEntry?.parsed?.id) assistantContext.value = activeEntry.parsed.id;
}

function parseMarkdown(text) {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function addMessage(role, content, isError = false) {
  const welcome = assistantMessages.querySelector(".assistant-welcome");
  if (welcome) welcome.remove();

  const msg = document.createElement("div");
  msg.className = `message ${role}${isError ? " error" : ""}`;

  if (role === "assistant" && !isError) {
    msg.innerHTML = parseMarkdown(content);
  } else {
    msg.textContent = content;
  }

  assistantMessages.appendChild(msg);
  assistantMessages.scrollTop = assistantMessages.scrollHeight;
  return msg;
}

async function sendMessage() {
  if (!assistantAvailable || !assistantInput) return;
  const q = assistantInput.value.trim();
  if (!q) return;

  assistantInput.value = "";
  assistantSend.disabled = true;
  addMessage("user", q);
  const loading = addMessage("assistant loading", "Thinking");

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: q,
        checkpointId: assistantContext?.value || activeEntry?.parsed?.id,
      }),
    });
    const data = await res.json();
    loading?.remove();
    addMessage("assistant", data.error || data.answer, !!data.error);
  } catch (err) {
    loading?.remove();
    addMessage("assistant", err.message, true);
  }
}

// ============================================
// Event Listeners
// ============================================

runBtn?.addEventListener("click", runCheckpoint);
btnPlay?.addEventListener("click", runCheckpoint);
btnStop?.addEventListener("click", stopRun);
btnPrev?.addEventListener("click", navigatePrev);
btnNext?.addEventListener("click", navigateNext);

btnAssistant?.addEventListener("click", openAssistant);
closeDrawer?.addEventListener("click", closeAssistantDrawer);
drawerOverlay?.addEventListener("click", closeAssistantDrawer);

assistantInput?.addEventListener("input", () => {
  assistantSend.disabled = !assistantInput.value.trim();
  assistantInput.style.height = "auto";
  assistantInput.style.height = Math.min(assistantInput.scrollHeight, 100) + "px";
});

assistantInput?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!assistantSend.disabled) sendMessage();
  }
});

assistantSend?.addEventListener("click", sendMessage);

document.getElementById("clear-logs")?.addEventListener("click", () => {
  logsEl.innerHTML = '<span class="log-placeholder">Run a checkpoint to see output...</span>';
  if (logCountEl) logCountEl.textContent = "0 lines";
});

searchEl?.addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  const filtered = timelineEntries.filter(entry => {
    const meta = parsePreview(entry);
    return [meta.title, meta.message, meta.gitSha].filter(Boolean).some(f => f.toLowerCase().includes(q));
  });
  renderTimeline(filtered);
  restoreSelection(filtered, { preferStored: false, allowFirst: false });
});

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (assistantDrawer?.classList.contains("open")) {
    if (e.key === "Escape") closeAssistantDrawer();
    return;
  }

  switch (e.key) {
    case "ArrowLeft": navigatePrev(); break;
    case "ArrowRight": navigateNext(); break;
    case "Enter": case " ": if (!runBtn.disabled) runCheckpoint(); e.preventDefault(); break;
    case "Escape": stopRun(); break;
  }
});

// ============================================
// Init
// ============================================

loadStatus();
loadTimeline().then(updateAssistantContext);
checkAssistantStatus();
