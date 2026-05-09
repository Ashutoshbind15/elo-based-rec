const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_MAIA_LEVELS = Object.freeze(
  Array.from({ length: 9 }, (_, index) => 1100 + index * 100)
);
const DEFAULT_BINARY_PATH = "/opt/lc0/bin/lc0";
const DEFAULT_CWD = "/opt/lc0";
const DEFAULT_WEIGHTS_DIR = "/opt/lc0/weights";

function validatePositiveInteger(name, value) {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsedValue;
}

function normalizeLevel(level, options = {}) {
  const allowedLevels = options.allowedLevels || DEFAULT_MAIA_LEVELS;
  const fallbackLevel =
    options.defaultLevel != null ? Number(options.defaultLevel) : allowedLevels[0];

  if (level == null || level === "") {
    return fallbackLevel;
  }

  const parsedLevel = Number(level);
  if (!Number.isInteger(parsedLevel)) {
    const error = new Error("`level` must be an integer rating");
    error.statusCode = 400;
    throw error;
  }

  if (!allowedLevels.includes(parsedLevel)) {
    const error = new Error(
      `Unsupported level ${parsedLevel}. Supported levels: ${allowedLevels.join(", ")}`
    );
    error.statusCode = 400;
    throw error;
  }

  return parsedLevel;
}

function resolveWeightsPath(weightsDir, level) {
  return path.join(weightsDir, `maia-${level}.pb.gz`);
}

function buildLc0Config(options = {}) {
  const levels = options.levels || DEFAULT_MAIA_LEVELS;
  const defaultLevel = normalizeLevel(
    options.defaultLevel ?? process.env.MAIA_DEFAULT_LEVEL,
    {
      allowedLevels: levels,
      defaultLevel: levels[0],
    }
  );
  const weightsDir = options.weightsDir || DEFAULT_WEIGHTS_DIR;

  const weightsByLevel = {};
  const missingLevels = [];

  for (const level of levels) {
    const weightsPath = resolveWeightsPath(weightsDir, level);
    weightsByLevel[level] = weightsPath;
    if (!fs.existsSync(weightsPath)) {
      missingLevels.push(level);
    }
  }

  if (missingLevels.length > 0) {
    throw new Error(
      `Missing Maia weights for levels: ${missingLevels.join(", ")} in ${weightsDir}`
    );
  }

  return {
    binaryPath: options.binaryPath || DEFAULT_BINARY_PATH,
    cwd: options.cwd || DEFAULT_CWD,
    nodes: validatePositiveInteger(
      "LC0_NODES",
      options.nodes ?? process.env.LC0_NODES ?? 1
    ),
    timeoutMs: validatePositiveInteger(
      "LC0_TIMEOUT_MS",
      options.timeoutMs ?? process.env.LC0_TIMEOUT_MS ?? 30000
    ),
    levels: [...levels],
    defaultLevel,
    weightsByLevel,
  };
}

function createState(config, level, weightsPath) {
  return {
    binaryPath: config.binaryPath,
    cwd: config.cwd,
    nodes: config.nodes,
    timeoutMs: config.timeoutMs,
    level,
    weightsPath,
    proc: null,
    stdoutBuffer: "",
    stderrBuffer: "",
    recentOutputLines: [],
    lineWaiters: [],
    ready: false,
    queue: Promise.resolve(),
  };
}

function dispatchLine(state, line) {
  if (!line) return;
  state.recentOutputLines.push(line);
  if (state.recentOutputLines.length > 30) {
    state.recentOutputLines.shift();
  }
  for (const waiter of [...state.lineWaiters]) {
    const match = line.match(waiter.pattern);
    if (!match) continue;
    clearTimeout(waiter.timer);
    state.lineWaiters = state.lineWaiters.filter((w) => w !== waiter);
    waiter.resolve({ line, match });
  }
}

function consumeChunk(state, chunk, stream) {
  const key = stream === "stderr" ? "stderrBuffer" : "stdoutBuffer";
  state[key] += chunk;

  while (true) {
    const nextBreak = state[key].indexOf("\n");
    if (nextBreak === -1) break;
    const line = state[key].slice(0, nextBreak).trim();
    state[key] = state[key].slice(nextBreak + 1);
    dispatchLine(state, line);
  }
}

function rejectAllWaiters(state, error) {
  for (const waiter of state.lineWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  state.lineWaiters = [];
}

function waitForLine(state, pattern, timeoutMs = state.timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.lineWaiters = state.lineWaiters.filter((w) => w !== waiter);
      reject(new Error(`Timed out waiting for line: ${String(pattern)}`));
    }, timeoutMs);

    const waiter = { pattern, resolve, reject, timer };
    state.lineWaiters.push(waiter);
  });
}

async function sendUciAndWait(state, command, pattern, timeoutMs = state.timeoutMs) {
  const pendingLine = waitForLine(state, pattern, timeoutMs);
  sendUci(state, command);
  return pendingLine;
}

function sendUci(state, command) {
  if (!state.proc || state.proc.killed) {
    throw new Error("lc0 process is not running");
  }
  state.proc.stdin.write(`${command}\n`);
}

async function startProcess(state) {
  if (state.proc && !state.proc.killed) {
    return;
  }

  const args = [];
  if (state.weightsPath) {
    state.recentOutputLines.push(
      `starting level=${state.level} weights=${state.weightsPath}`
    );
    args.push(`--weights=${state.weightsPath}`);
  }

  state.proc = spawn(state.binaryPath, args, {
    cwd: state.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  state.proc.stdout.setEncoding("utf8");
  state.proc.stderr.setEncoding("utf8");

  state.proc.stdout.on("data", (chunk) => {
    consumeChunk(state, chunk, "stdout");
  });
  state.proc.stderr.on("data", (chunk) => {
    consumeChunk(state, chunk, "stderr");
  });

  state.proc.on("exit", (code, signal) => {
    state.ready = false;
    state.proc = null;
    const recent = state.recentOutputLines.slice(-8).join(" | ");
    const details = recent ? `; recent_output=${recent}` : "";
    rejectAllWaiters(
      state,
      new Error(
        `lc0 process for level ${state.level} exited (code=${code}, signal=${signal})${details}`
      )
    );
  });

  state.proc.on("error", (err) => {
    state.ready = false;
    rejectAllWaiters(state, err);
  });
}

async function handshake(state) {
  await sendUciAndWait(state, "uci", /^uciok$/);
  await sendUciAndWait(state, "isready", /^readyok$/);
  state.ready = true;
}

async function initLc0(state) {
  if (state.ready) return;
  await startProcess(state);
  await handshake(state);
}

function enqueue(state, task) {
  const run = state.queue.then(task);
  state.queue = run.catch(() => {});
  return run;
}

async function getBestMoveForState(state, fen) {
  if (!fen || typeof fen !== "string") {
    throw new Error("FEN is required");
  }

  return enqueue(state, async () => {
    if (!state.ready) {
      await initLc0(state);
    }

    await sendUciAndWait(state, "isready", /^readyok$/);
    sendUci(state, `position fen ${fen}`);
    const bestMoveResponse = waitForLine(state, /^bestmove\s+(\S+)/);
    sendUci(state, `go nodes ${state.nodes}`);

    const { match } = await bestMoveResponse;
    return match[1];
  });
}

async function closeLc0(state) {
  if (!state.proc || state.proc.killed) return;
  state.proc.kill("SIGTERM");
}

/**
 * @param {object} [options]
 * @returns {{
 *   init: () => Promise<void>,
 *   getBestMove: (fen: string, level?: number | string) => Promise<string>,
 *   resolveLevel: (level?: number | string) => number,
 *   getAvailableLevels: () => number[],
 *   getDefaultLevel: () => number,
 *   close: () => Promise<void>
 * }}
 */
function createLc0Client(options = {}) {
  const config = buildLc0Config(options);
  const statesByLevel = new Map(
    config.levels.map((level) => [
      level,
      createState(config, level, config.weightsByLevel[level]),
    ])
  );

  function resolveLevelOrThrow(level) {
    const resolvedLevel = normalizeLevel(level, {
      allowedLevels: config.levels,
      defaultLevel: config.defaultLevel,
    });

    if (!statesByLevel.has(resolvedLevel)) {
      const error = new Error(`No weights configured for level ${resolvedLevel}`);
      error.statusCode = 400;
      throw error;
    }

    return resolvedLevel;
  }

  return {
    init: async () => {
      await Promise.all([...statesByLevel.values()].map((state) => initLc0(state)));
    },
    getBestMove: async (fen, level) => {
      const resolvedLevel = resolveLevelOrThrow(level);
      return getBestMoveForState(statesByLevel.get(resolvedLevel), fen);
    },
    resolveLevel: (level) => resolveLevelOrThrow(level),
    getAvailableLevels: () => [...config.levels],
    getDefaultLevel: () => config.defaultLevel,
    close: async () => {
      await Promise.all([...statesByLevel.values()].map((state) => closeLc0(state)));
    },
  };
}

module.exports = {
  DEFAULT_MAIA_LEVELS,
  DEFAULT_BINARY_PATH,
  DEFAULT_CWD,
  DEFAULT_WEIGHTS_DIR,
  validatePositiveInteger,
  normalizeLevel,
  resolveWeightsPath,
  buildLc0Config,
  createLc0Client,
};
