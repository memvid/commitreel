const path = require("path");
const { create, use } = require("@memvid/sdk");
const { info, warn } = require("./logger");

function createMutex() {
  let current = Promise.resolve();
  return async (fn) => {
    const next = current.then(fn, fn);
    current = next.catch(() => {});
    return next;
  };
}

async function openMemory(outPath) {
  const resolved = path.resolve(outPath);
  let mv;
  try {
    mv = await use("basic", resolved, { mode: "open" });
  } catch (err) {
    mv = await create(resolved);
    await mv.enableLex();
    info(`created new tape: ${resolved}`);
  }
  return mv;
}

function buildMemvid(outPath) {
  const withLock = createMutex();
  let mvPromise;

  async function getHandle() {
    if (!mvPromise) {
      mvPromise = openMemory(outPath);
    }
    return mvPromise;
  }

  async function withMemvid(fn) {
    return withLock(async () => {
      const mv = await getHandle();
      const result = await fn(mv);
      await mv.seal();
      return result;
    });
  }

  async function close() {
    if (!mvPromise) return;
    const mv = await mvPromise;
    try {
      await mv.seal();
    } catch (err) {
      warn("failed to seal tape on close");
    }
  }

  return {
    withMemvid,
    close,
  };
}

module.exports = {
  buildMemvid,
};
