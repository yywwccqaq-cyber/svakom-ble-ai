import { configFromEnvironment, createRelayApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

try {
  const { app } = createRelayApp(configFromEnvironment());
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`SVAKOM Kelivo MCP relay listening on port ${port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
