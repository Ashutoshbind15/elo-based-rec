import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { badRequest, lc0Error, toLc0Error, type Lc0Error } from "./errors.js";

const DEFAULT_MAIA_LEVELS = Object.freeze(
  Array.from({ length: 9 }, (_, index) => 1100 + index * 100),
);
const DEFAULT_BINARY_PATH = "/opt/lc0/bin/lc0";
const DEFAULT_CWD = "/opt/lc0";
const DEFAULT_WEIGHTS_DIR = "/opt/lc0/weights";

type NormalizeLevelOptions = {
  allowedLevels?: readonly number[];
  defaultLevel?: number;
};

type Lc0Config = {
  binaryPath: string;
  cwd: string;
  nodes: number;
  timeoutMs: number;
  levels: number[];
  defaultLevel: number;
  weightsByLevel: Record<number, string>;
};

type LineWaiter = {
  pattern: RegExp;
  resolve: (value: { line: string; match: RegExpMatchArray }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Lc0State = {
  binaryPath: string;
  cwd: string;
  nodes: number;
  timeoutMs: number;
  level: number;
  weightsPath: string;
  proc: ChildProcessWithoutNullStreams | null;
  stdoutBuffer: string;
  stderrBuffer: string;
  recentOutputLines: string[];
  lineWaiters: LineWaiter[];
  ready: boolean;
  queue: Promise<unknown>;
};

export type Lc0ClientOptions = {
  binaryPath?: string;
  cwd?: string;
  weightsDir?: string;
  levels?: readonly number[];
  defaultLevel?: number | string;
  nodes?: number | string;
  timeoutMs?: number | string;
};

export type Lc0Client = {
  init: () => ResultAsync<void, Lc0Error>;
  getBestMove: (
    fen: string,
    level?: number | string,
  ) => ResultAsync<{ bestMove: string; level: number }, Lc0Error>;
  getAvailableLevels: () => number[];
  getDefaultLevel: () => number;
  close: () => ResultAsync<void, Lc0Error>;
};

function validatePositiveInteger(name: string, value: unknown): Result<number, Lc0Error> {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return err(lc0Error(`${name} must be a positive integer`));
  }
  return ok(parsedValue);
}

function normalizeLevel(
  level: number | string | null | undefined,
  options: NormalizeLevelOptions = {},
): Result<number, Lc0Error> {
  const allowedLevels = options.allowedLevels ?? DEFAULT_MAIA_LEVELS;
  const fallbackLevel =
    options.defaultLevel != null ? Number(options.defaultLevel) : allowedLevels[0];

  if (level == null || level === "") {
    return ok(fallbackLevel);
  }

  const parsedLevel = Number(level);
  if (!Number.isInteger(parsedLevel)) {
    return err(badRequest("`level` must be an integer rating"));
  }

  if (!allowedLevels.includes(parsedLevel)) {
    return err(
      badRequest(
        `Unsupported level ${parsedLevel}. Supported levels: ${allowedLevels.join(", ")}`,
      ),
    );
  }

  return ok(parsedLevel);
}

function resolveWeightsPath(weightsDir: string, level: number): string {
  return path.join(weightsDir, `maia-${level}.pb.gz`);
}

function buildLc0Config(options: Lc0ClientOptions = {}): Result<Lc0Config, Lc0Error> {
  const levels = options.levels ?? DEFAULT_MAIA_LEVELS;
  const weightsDir = options.weightsDir ?? DEFAULT_WEIGHTS_DIR;

  return normalizeLevel(options.defaultLevel ?? process.env.MAIA_DEFAULT_LEVEL, {
    allowedLevels: levels,
    defaultLevel: levels[0],
  }).andThen((defaultLevel) =>
    validatePositiveInteger("LC0_NODES", options.nodes ?? process.env.LC0_NODES ?? 1).andThen(
      (nodes) =>
        validatePositiveInteger(
          "LC0_TIMEOUT_MS",
          options.timeoutMs ?? process.env.LC0_TIMEOUT_MS ?? 30000,
        ).andThen((timeoutMs) => {
          const weightsByLevel: Record<number, string> = {};
          const missingLevels: number[] = [];

          for (const level of levels) {
            const weightsPath = resolveWeightsPath(weightsDir, level);
            weightsByLevel[level] = weightsPath;
            if (!fs.existsSync(weightsPath)) {
              missingLevels.push(level);
            }
          }

          if (missingLevels.length > 0) {
            return err(
              lc0Error(
                `Missing Maia weights for levels: ${missingLevels.join(", ")} in ${weightsDir}`,
              ),
            );
          }

          return ok({
            binaryPath: options.binaryPath ?? DEFAULT_BINARY_PATH,
            cwd: options.cwd ?? DEFAULT_CWD,
            nodes,
            timeoutMs,
            levels: [...levels],
            defaultLevel,
            weightsByLevel,
          });
        }),
    ),
  );
}

function createState(config: Lc0Config, level: number, weightsPath: string): Lc0State {
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

function dispatchLine(state: Lc0State, line: string): void {
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

function consumeChunk(state: Lc0State, chunk: string, stream: "stdout" | "stderr"): void {
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

function rejectAllWaiters(state: Lc0State, error: Error): void {
  for (const waiter of state.lineWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  state.lineWaiters = [];
}

function waitForLine(
  state: Lc0State,
  pattern: RegExp,
  timeoutMs = state.timeoutMs,
): ResultAsync<{ line: string; match: RegExpMatchArray }, Lc0Error> {
  return ResultAsync.fromPromise(
    new Promise<{ line: string; match: RegExpMatchArray }>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.lineWaiters = state.lineWaiters.filter((w) => w !== waiter);
        reject(new Error(`Timed out waiting for line: ${String(pattern)}`));
      }, timeoutMs);

      const waiter: LineWaiter = { pattern, resolve, reject, timer };
      state.lineWaiters.push(waiter);
    }),
    (error) => lc0Error(error instanceof Error ? error.message : "Engine read failed"),
  );
}

function sendUci(state: Lc0State, command: string): Result<void, Lc0Error> {
  if (!state.proc || state.proc.killed) {
    return err(lc0Error("lc0 process is not running"));
  }
  state.proc.stdin.write(`${command}\n`);
  return ok(undefined);
}

function sendUciAndWait(
  state: Lc0State,
  command: string,
  pattern: RegExp,
  timeoutMs = state.timeoutMs,
): ResultAsync<{ line: string; match: RegExpMatchArray }, Lc0Error> {
  return sendUci(state, command).asyncAndThen(() => waitForLine(state, pattern, timeoutMs));
}

function startProcess(state: Lc0State): ResultAsync<void, Lc0Error> {
  if (state.proc && !state.proc.killed) {
    return okAsync(undefined);
  }

  const args: string[] = [];
  if (state.weightsPath) {
    state.recentOutputLines.push(
      `starting level=${state.level} weights=${state.weightsPath}`,
    );
    args.push(`--weights=${state.weightsPath}`);
  }

  return ResultAsync.fromPromise(
    new Promise<void>((resolve, reject) => {
      const proc = spawn(state.binaryPath, args, {
        cwd: state.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      state.proc = proc;
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      proc.stdout.on("data", (chunk: string) => {
        consumeChunk(state, chunk, "stdout");
      });
      proc.stderr.on("data", (chunk: string) => {
        consumeChunk(state, chunk, "stderr");
      });

      proc.on("exit", (code, signal) => {
        state.ready = false;
        state.proc = null;
        const recent = state.recentOutputLines.slice(-8).join(" | ");
        const details = recent ? `; recent_output=${recent}` : "";
        rejectAllWaiters(
          state,
          new Error(
            `lc0 process for level ${state.level} exited (code=${code}, signal=${signal})${details}`,
          ),
        );
      });

      proc.on("error", (spawnError) => {
        state.ready = false;
        rejectAllWaiters(state, spawnError);
        reject(spawnError);
      });

      resolve();
    }),
    (error) => lc0Error(error instanceof Error ? error.message : "Failed to start lc0"),
  );
}

function handshake(state: Lc0State): ResultAsync<void, Lc0Error> {
  return sendUciAndWait(state, "uci", /^uciok$/)
    .andThen(() => sendUciAndWait(state, "isready", /^readyok$/))
    .map(() => {
      state.ready = true;
    });
}

function initLc0(state: Lc0State): ResultAsync<void, Lc0Error> {
  if (state.ready) {
    return okAsync(undefined);
  }
  return startProcess(state).andThen(() => handshake(state));
}

function enqueue<T>(
  state: Lc0State,
  task: () => ResultAsync<T, Lc0Error>,
): ResultAsync<T, Lc0Error> {
  const chained = ResultAsync.fromSafePromise(state.queue).andThen(task);
  state.queue = chained.match(
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
  return chained;
}

function getBestMoveForState(
  state: Lc0State,
  fen: string,
): ResultAsync<string, Lc0Error> {
  if (!fen || typeof fen !== "string") {
    return errAsync(lc0Error("FEN is required"));
  }

  return enqueue(state, () => {
    const ready = state.ready ? okAsync(undefined) : initLc0(state);

    return ready
      .andThen(() => sendUciAndWait(state, "isready", /^readyok$/))
      .andThen(() =>
        sendUci(state, `position fen ${fen}`).asyncAndThen(() => {
          const bestMoveResponse = waitForLine(state, /^bestmove\s+(\S+)/);
          return sendUci(state, `go nodes ${state.nodes}`).asyncAndThen(() =>
            bestMoveResponse.map(({ match }) => match[1] as string),
          );
        }),
      );
  });
}

function closeLc0(state: Lc0State): ResultAsync<void, Lc0Error> {
  if (!state.proc || state.proc.killed) {
    return okAsync(undefined);
  }
  state.proc.kill("SIGTERM");
  return okAsync(undefined);
}

export function createLc0Client(options: Lc0ClientOptions = {}): Result<Lc0Client, Lc0Error> {
  return buildLc0Config(options).map((config) => {
    const statesByLevel = new Map(
      config.levels.map((level) => [
        level,
        createState(config, level, config.weightsByLevel[level]!),
      ]),
    );

    function resolveLevel(level?: number | string): Result<number, Lc0Error> {
      return normalizeLevel(level, {
        allowedLevels: config.levels,
        defaultLevel: config.defaultLevel,
      }).andThen((resolvedLevel) =>
        statesByLevel.has(resolvedLevel)
          ? ok(resolvedLevel)
          : err(badRequest(`No weights configured for level ${resolvedLevel}`)),
      );
    }

    return {
      init: () =>
        ResultAsync.combine([...statesByLevel.values()].map((state) => initLc0(state))).map(
          () => undefined,
        ),
      getBestMove: (fen, level) =>
        resolveLevel(level).asyncAndThen((resolvedLevel) =>
          getBestMoveForState(statesByLevel.get(resolvedLevel)!, fen).map((bestMove) => ({
            bestMove,
            level: resolvedLevel,
          })),
        ),
      getAvailableLevels: () => [...config.levels],
      getDefaultLevel: () => config.defaultLevel,
      close: () =>
        ResultAsync.combine([...statesByLevel.values()].map((state) => closeLc0(state))).map(
          () => undefined,
        ),
    };
  });
}
