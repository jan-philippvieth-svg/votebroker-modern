import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerConsentRoutes } from "./consent/routes.js";
import { registerCurationRoutes } from "./curation/routes.js";
import { getDb } from "./db/index.js";
import { registerOperatorRoutes } from "./operator/routes.js";
import { registerRoutes } from "./routes.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { startDailyFeePostScheduler, runDailyFeePost } from "./jobs/dailyFeePost.js";
import { registerContentRoutes } from "./admin/contentRoutes.js";
import { registerStrategyRoutes } from "./strategy/routes.js";

// Initialize DB on startup (creates tables, prunes expired sessions)
getDb();

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});
await registerAuthRoutes(app);
await registerConsentRoutes(app);
await registerCurationRoutes(app);
await registerOperatorRoutes(app);
await registerAdminRoutes(app);
await registerContentRoutes(app);
await registerStrategyRoutes(app);
await registerRoutes(app);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });

// Start daily fee post scheduler after server is listening
// Runs at 01:00 UTC every day — idempotent, safe to call multiple times
startDailyFeePostScheduler(app.log as unknown as typeof console);
