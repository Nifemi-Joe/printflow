import { createApp, createDeps } from "./app.js";
import { checkoutMode, loadConfig } from "./config.js";

const cfg = loadConfig();
const deps = createDeps(cfg);
const app = await createApp(cfg, deps);
await app.listen(cfg.PORT, "0.0.0.0");
deps.log.info({ port: cfg.PORT, checkout: checkoutMode(cfg), storage: deps.storage.driver, env: cfg.NODE_ENV }, "PrintFlow API listening");

const shutdown = async (signal: string) => {
  deps.log.info({ signal }, "shutting down");
  await app.close();
  await deps.pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
