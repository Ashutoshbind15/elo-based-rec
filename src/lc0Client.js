const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function expandHomePath(input) {
  if (!input || typeof input !== "string") return input;
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveDefaultCwd(binaryPath) {
  const expandedBinary = expandHomePath(binaryPath);
  if (!expandedBinary || expandedBinary === "lc0") {
    return process.cwd();
  }
  if (expandedBinary.includes(path.sep)) {
    return path.dirname(path.resolve(expandedBinary));
  }
  return process.cwd();
}

function detectWeightsFile(searchDir) {
  try {
    const files = fs.readdirSync(searchDir);
    const candidates = files.filter(
      (file) => file.endsWith(".pb.gz") || file.endsWith(".pb")
    );
    if (candidates.length === 0) {
      return null;
    }

    const maiaFirst = [...candidates].sort((a, b) => {
      const aScore = a.toLowerCase().includes("maia") ? 0 : 1;
      const bScore = b.toLowerCase().includes("maia") ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return a.localeCompare(b);
    });

    return path.join(searchDir, maiaFirst[0]);
  } catch {
    return null;
  }
}

function buildLc0Config(options = {}) {
  const rawBinaryPath = options.binaryPath || process.env.LC0_BINARY || "lc0";
  const expandedBinaryPath = expandHomePath(rawBinaryPath);

  const cwdBase =
    expandHomePath(options.cwd || process.env.LC0_CWD) ||
    resolveDefaultCwd(expandedBinaryPath);
  const cwd = path.resolve(cwdBase);

  const binaryPath = expandedBinaryPath.includes(path.sep)
    ? path.resolve(cwd, expandedBinaryPath)
    : expandedBinaryPath;

  const rawWeightsPath =
    options.weightsPath || process.env.LC0_WEIGHTS || detectWeightsFile(cwd);
  const expandedWeightsPath = expandHomePath(rawWeightsPath);

  return {
    binaryPath,
    cwd,
    nodes: Number(options.nodes || process.env.LC0_NODES || 1),
    timeoutMs: Number(options.timeoutMs || process.env.LC0_TIMEOUT_MS || 30000),
    weightsPath: expandedWeightsPath
      ? path.resolve(cwd, expandedWeightsPath)
      : null,
  };
}

function createState(config) {
  return {
    ...config,
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
    state.recentOutputLines.push(`starting with weights=${state.weightsPath}`);
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
    const recent = state.recentOutputLines.slice(-8).join(" | ");
    const details = recent ? `; recent_output=${recent}` : "";
    rejectAllWaiters(
      state,
      new Error(`lc0 process exited (code=${code}, signal=${signal})${details}`)
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
 * @returns {{ init: () => Promise<void>, getBestMove: (fen: string) => Promise<string>, close: () => Promise<void> }}
 */
function createLc0Client(options = {}) {
  const state = createState(buildLc0Config(options));

  return {
    init: () => initLc0(state),
    getBestMove: (fen) => getBestMoveForState(state, fen),
    close: () => closeLc0(state),
  };
}

module.exports = {
  expandHomePath,
  resolveDefaultCwd,
  detectWeightsFile,
  buildLc0Config,
  createLc0Client,
};
