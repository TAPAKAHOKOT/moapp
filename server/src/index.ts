import { buildApp } from "./app.js";
import { configFromEnv } from "./config.js";

const config = configFromEnv();
const app = await buildApp(config);
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
