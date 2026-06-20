import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerConsentRoutes } from "./consent/routes.js";
import { registerCurationRoutes, registerUserSettingsRoutes } from "./curation/routes.js";
import { getDb } from "./db/index.js";
import { registerOperatorRoutes } from "./operator/routes.js";
import { registerRoutes, registerTodayVotesRoute } from "./routes.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { startDailyFeePostScheduler, runDailyFeePost } from "./jobs/dailyFeePost.js";
import { startDailyDevlogScheduler, generateDevlogDraft } from "./jobs/dailyDevlog.js";
import { startVpSampler } from "./jobs/vpSampler.js";
import { startPriceSampler } from "./jobs/priceSampler.js";
import { startWhaleEnrichment } from "./jobs/whaleEnrichment.js";
import { startPayoutSync } from "./jobs/payoutSync.js";
import { startSignalCompute } from "./jobs/signalCompute.js";
import { startCopilotShadow } from "./jobs/copilotShadowJob.js";
import { startShadowOutcomeResolver } from "./jobs/shadowOutcomeResolverJob.js";
import { startOpportunityRefresh } from "./jobs/opportunityRefreshJob.js";
import { startGrowthSnapshotSampler } from "./jobs/growthSnapshotSampler.js";
import { startRetention } from "./jobs/retentionJob.js";
import { startWhaleHistoryScanner } from "./chain/whaleHistoryScanner.js";
import { startPostScanner } from "./jobs/postScannerJob.js";
import { registerContentRoutes } from "./admin/contentRoutes.js";
import { registerStrategyRoutes } from "./strategy/routes.js";

// Initialize DB on startup (creates tables, prunes expired sessions)
getDb();

const app = Fastify({
  logger: true,
  // Fronted by Caddy — trust X-Forwarded-* so request.ip is the real client IP.
  // Required for per-IP rate limiting to work (otherwise every request looks
  // like it comes from the reverse proxy).
  trustProxy: true
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
registerUserSettingsRoutes(app);
await registerOperatorRoutes(app);
await registerAdminRoutes(app);
await registerContentRoutes(app);
await registerStrategyRoutes(app);
await registerRoutes(app);
registerTodayVotesRoute(app);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });

const log = app.log as unknown as typeof console;

// Schedulers that only register a setTimeout (no immediate I/O) — safe to start now.
// startPayoutSync's immediate run is delayed 120s internally.
startDailyFeePostScheduler(log);
startDailyDevlogScheduler(log);
startPayoutSync(log);

// Jobs that make immediate Steem/external API calls are delayed 30s so Docker's
// health check (start_period 90s, first check at 15s) can succeed before we
// saturate the event loop with external API calls.
setTimeout(() => {
  startPostScanner(log);   // must start before other scanners — warms vb_posts for DB-first reads
  startVpSampler(log);
  startPriceSampler(log);
  startWhaleEnrichment(log);
  startCopilotShadow(log);
  startShadowOutcomeResolver(log);
  startGrowthSnapshotSampler(log);
  startSignalCompute(log);
  startOpportunityRefresh(log);
  startRetention(log);
  startWhaleHistoryScanner(log); // periodic — keeps vb_whale_vote_details fresh so opportunities don't dry up
}, 30_000);
