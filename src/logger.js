const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel = levels.info;

function setVerbose(enabled) {
  currentLevel = enabled ? levels.debug : levels.info;
}

function log(level, message) {
  if (levels[level] <= currentLevel) {
    const prefix = level === "info" ? "" : `${level}: `;
    console.log(`${prefix}${message}`);
  }
}

module.exports = {
  setVerbose,
  info: (msg) => log("info", msg),
  warn: (msg) => log("warn", msg),
  error: (msg) => log("error", msg),
  debug: (msg) => log("debug", msg),
};
