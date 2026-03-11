import { loadConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { createLogger } from "./logger.js";
import { StreamMonitor } from "./monitor.js";
import { EmailNotifier } from "./notifier.js";
import { RuntimeMetrics } from "./runtime-metrics.js";
import { loadOrCreateMasterKey } from "./security.js";
import { startWebServer } from "./web.js";

async function main() {
  const args = new Set(process.argv.slice(2));
  const logger = createLogger();
  const config = loadConfig();
  const masterKey = loadOrCreateMasterKey(config.security.keyFilePath, config.security.appKey);
  const database = new AppDatabase(config.database, masterKey, logger);
  const notifier = new EmailNotifier(database, logger);
  const monitor = new StreamMonitor(database, notifier, logger);
  const runtimeMetrics = new RuntimeMetrics();

  if (args.has("--check-config")) {
    const setup = database.getSetupStatus();
    logger.info("Configuration loaded successfully", {
      setupRequired: setup.setupRequired,
      databasePath: config.database.dbPath
    });
    return;
  }

  if (args.has("--once")) {
    await monitor.runOnce("manual");
    return;
  }

  logger.info("Starting stream watchdog service", {
    port: config.web.port,
    databasePath: config.database.dbPath
  });
  monitor.start();
  startWebServer({ config, database, monitor, notifier, logger, runtimeMetrics });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
