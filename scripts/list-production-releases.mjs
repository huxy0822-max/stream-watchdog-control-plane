import {
  connectRemote,
  getProductionConfig,
  listRemoteBackups,
  loadProductionDeployEnv
} from "./production-remote.mjs";

loadProductionDeployEnv();

const config = getProductionConfig();
const client = await connectRemote(config);

try {
  const backups = await listRemoteBackups(client, config);
  if (backups.length === 0) {
    console.log("No production backups found.");
  } else {
    for (const backup of backups) {
      console.log(backup);
    }
  }
} finally {
  client.end();
}
