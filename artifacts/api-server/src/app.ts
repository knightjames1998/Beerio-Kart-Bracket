import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the built Beerio Kart SPA (so host + spectators share one origin).
// Bundled server lives at artifacts/api-server/dist/index.mjs, so the client
// build sits two levels up under beerio-kart/dist/public.
const clientDir = path.resolve(import.meta.dirname, "../../beerio-kart/dist/public");
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  // SPA fallback for any non-API route.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
  logger.info({ clientDir }, "Serving client build");
} else {
  logger.warn({ clientDir }, "Client build not found — API only. Run the beerio-kart build first.");
}

export default app;
