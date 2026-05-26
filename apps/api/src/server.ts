import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerConsentRoutes } from "./consent/routes.js";
import { registerOperatorRoutes } from "./operator/routes.js";
import { registerRoutes } from "./routes.js";

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});
await registerAuthRoutes(app);
await registerConsentRoutes(app);
await registerOperatorRoutes(app);
await registerRoutes(app);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
