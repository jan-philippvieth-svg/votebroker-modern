import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerConsentRoutes } from "./consent/routes.js";
import { registerCurationRoutes } from "./curation/routes.js";
import { getDb } from "./db/index.js";
import { registerOperatorRoutes } from "./operator/routes.js";
import { registerRoutes, registerTodayVotesRoute } from "./routes.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { startDailyFeePostScheduler, runDailyFeePost } from "./jobs/dailyFeePost.js";
import { startDailyDevlogScheduler, generateDevlogDraft } from "./jobs/dailyDevlog.js";
import { startVpSampler } from "./jobs/vpSampler.js";
import { startPriceSampler } from "./jobs/priceSampler.js";
import { startWhaleEnrichment } from "./jobs/whaleEnrichment.js";
import { startSignalCompute } from "./jobs/signalCompute.js";
import { scanWhaleHistory } from "./chain/whaleHistoryScanner.js";
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

await app.register(swagger, {
  openapi: {
    info: {
      title: "VoteBroker API",
      description: "VoteBroker Curation Management API",
      version: "0.1.0",
    },
    components: {
      securitySchemes: {
        sessionToken: {
          type: "apiKey",
          in: "header",
          name: "session",
        },
      },
    },
  },
});

await app.register(swaggerUi, {
  routePrefix: "/api/docs",
  uiConfig: { docExpansion: "list" },
});
await registerAuthRoutes(app);
await registerConsentRoutes(app);
await registerCurationRoutes(app);
await registerOperatorRoutes(app);
await registerAdminRoutes(app);
await registerContentRoutes(app);
await registerStrategyRoutes(app);
await registerRoutes(app);
registerTodayVotesRoute(app);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });

// Start daily fee post scheduler after server is listening
// Runs at 01:00 UTC every day — idempotent, safe to call multiple times
startDailyFeePostScheduler(app.log as unknown as typeof console);

// Start daily devlog draft generator — runs at 22:00 UTC, writes to CONTENT_DIR
startDailyDevlogScheduler(app.log as unknown as typeof console);

// Start VP time-series sampler — samples VP for all active sessions every 15 min
startVpSampler(app.log as unknown as typeof console);

// Start daily price sampler — fetches STEEM/SBD USD prices from CoinGecko (fallback: Steem feed)
startPriceSampler(app.log as unknown as typeof console);

// Signal Layer: historical whale scan → enrichment → nightly signal compute
// Scan runs in background (rate-limited, can take minutes); non-blocking
const log = app.log as unknown as typeof console;
scanWhaleHistory(log).catch(e => log.warn("[WhaleHistory] startup scan error:", e));
startWhaleEnrichment(log);
startSignalCompute(log);
