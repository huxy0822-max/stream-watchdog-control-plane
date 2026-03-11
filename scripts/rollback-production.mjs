import {
  connectRemote,
  execRemote,
  getProductionConfig,
  hasArg,
  listRemoteBackups,
  loadProductionDeployEnv,
  parseArgValue,
  remoteQuote
} from "./production-remote.mjs";

loadProductionDeployEnv();

const config = getProductionConfig();
const client = await connectRemote(config);

try {
  const backups = await listRemoteBackups(client, config);
  if (hasArg("list")) {
    if (backups.length === 0) {
      console.log("No production backups found.");
    } else {
      for (const backup of backups) {
        console.log(backup);
      }
    }
    process.exit(0);
  }

  if (backups.length === 0) {
    throw new Error("No production backups found. Deploy once before attempting rollback.");
  }

  const requestedRelease = String(parseArgValue("release", backups[0])).trim() || backups[0];
  if (!backups.includes(requestedRelease)) {
    throw new Error(`Unknown backup release: ${requestedRelease}`);
  }

  await execRemote(client, `
    set -e
    if [ ! -d ${remoteQuote(`${config.backupRoot}/${requestedRelease}`)} ]; then
      echo "Backup does not exist" >&2
      exit 1
    fi
    rm -rf ${remoteQuote(config.appDir)}
    mkdir -p ${remoteQuote(config.appDir)}
    cp -a ${remoteQuote(`${config.backupRoot}/${requestedRelease}/.`)} ${remoteQuote(`${config.appDir}/`)}
    cd ${remoteQuote(config.appDir)}
    docker compose up -d --build
  `);

  console.log(`Rollback finished: ${requestedRelease}`);
} finally {
  client.end();
}
