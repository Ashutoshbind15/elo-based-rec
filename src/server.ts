import "dotenv/config";

import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { err, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { createLc0Client, type Lc0Client } from "./lc0Client.js";
import { toLc0Error, type Lc0Error } from "./errors.js";
import { parseSchema } from "./validate.js";

const PORT = Number(process.env.PORT || 8787);
const SHOULD_EAGER_INIT = process.env.LC0_EAGER_INIT === "true";

const app = express();
app.use(express.json({ limit: "1mb" }));

const clientResult = createLc0Client();
if (clientResult.isErr()) {
  process.stderr.write(`Failed to create lc0 client: ${clientResult.error.message}\n`);
  process.exit(1);
}

const client: Lc0Client = clientResult.value;
let server: Server | null = null;

const bestMoveRequestSchema = z.object({
  fen: z.string().trim().min(1, "Missing or invalid `fen` string"),
  level: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.union([z.number(), z.string()]).optional(),
  ),
});

type BestMovePayload = z.infer<typeof bestMoveRequestSchema>;

type BestMoveResponse = {
  bestMove: string;
  level: number;
};

function sendError(res: Response, error: Lc0Error): void {
  res.status(error.statusCode).json({ error: error.message });
}

function respondWithResult<T>(res: Response, result: Result<T, Lc0Error>, onOk: (value: T) => void): void {
  result.match(onOk, (error) => sendError(res, error));
}

async function respondWithResultAsync<T>(
  res: Response,
  resultAsync: ResultAsync<T, Lc0Error>,
  onOk: (value: T) => void,
): Promise<void> {
  respondWithResult(res, await resultAsync, onOk);
}

function parseBestMoveRequest(req: Request): Result<BestMovePayload, Lc0Error> {
  return parseSchema(bestMoveRequestSchema, {
    fen: req.body?.fen,
    level: req.body?.level ?? req.query.level,
  });
}

function bestMoveForRequest(req: Request): ResultAsync<BestMoveResponse, Lc0Error> {
  return parseBestMoveRequest(req).asyncAndThen(({ fen, level }) =>
    client.getBestMove(fen, level),
  );
}

function listen(port: number): ResultAsync<Server, Lc0Error> {
  return ResultAsync.fromPromise(
    new Promise<Server>((resolve, reject) => {
      const nextServer = app.listen(port, () => resolve(nextServer));
      nextServer.on("error", reject);
    }),
    toLc0Error,
  );
}

function closeServer(nextServer: Server): ResultAsync<void, Lc0Error> {
  return ResultAsync.fromPromise(
    new Promise<void>((resolve, reject) => {
      nextServer.close((error) => (error ? reject(error) : resolve()));
    }),
    toLc0Error,
  );
}

function start(): ResultAsync<void, Lc0Error> {
  const eagerInit = SHOULD_EAGER_INIT ? client.init() : okAsync(undefined);
  return eagerInit
    .andThen(() => listen(PORT))
    .map((nextServer) => {
      server = nextServer;
      process.stdout.write(`lc0 API listening on http://localhost:${PORT}\n`);
    });
}

function shutdown(): ResultAsync<void, Lc0Error> {
  const closeHttp = server ? closeServer(server) : okAsync(undefined);
  return closeHttp.andThen(() => client.close()).map(() => process.exit(0));
}

function registerGracefulShutdown(runShutdown: () => ResultAsync<void, Lc0Error>): void {
  let shuttingDown = false;

  const onSignal = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    void runShutdown().match(
      () => undefined,
      (error) => {
        process.stderr.write(`Shutdown failed: ${error.message}\n`);
        process.exit(1);
      },
    );
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, onSignal);
  }
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    defaultLevel: client.getDefaultLevel(),
    availableLevels: client.getAvailableLevels(),
  });
});

app.post("/best-move", (req: Request, res: Response) => {
  void respondWithResultAsync(res, bestMoveForRequest(req), (payload) => {
    res.json(payload);
  });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found" });
});

registerGracefulShutdown(shutdown);

void start().match(
  () => undefined,
  (error) => {
    process.stderr.write(`Failed to start lc0 API: ${error.message}\n`);
    process.exit(1);
  },
);
