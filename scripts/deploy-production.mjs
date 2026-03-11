import {
  collectProjectFiles,
  connectRemote,
  execRemote,
  getCurrentGitSha,
  getProductionConfig,
  listRemoteBackups,
  loadProductionDeployEnv,
  openSftp,
  remoteQuote,
  timestampTag,
  uploadProjectTree
} from "./production-remote.mjs";

loadProductionDeployEnv();

const config = getProductionConfig();
const gitSha = getCurrentGitSha();
const releaseName = `${timestampTag()}-${gitSha}`;
const uploadRoot = `${config.appDir}.upload-${releaseName}`;
const relativeFiles = collectProjectFiles();
const client = await connectRemote(config);

try {
  console.log(`Uploading ${relativeFiles.length} files to ${config.host}:${uploadRoot}`);
  const sftp = await openSftp(client);
  await execRemote(client, `rm -rf ${remoteQuote(uploadRoot)} && mkdir -p ${remoteQuote(uploadRoot)}`);
  await uploadProjectTree(sftp, uploadRoot, relativeFiles);

  console.log(`Creating backup ${releaseName}`);
  await execRemote(client, `
    set -e
    mkdir -p ${remoteQuote(config.backupRoot)}
    if [ -d ${remoteQuote(config.appDir)} ]; then
      rm -rf ${remoteQuote(`${config.backupRoot}/${releaseName}`)}
      mkdir -p ${remoteQuote(`${config.backupRoot}/${releaseName}`)}
      cp -a ${remoteQuote(`${config.appDir}/.`)} ${remoteQuote(`${config.backupRoot}/${releaseName}/`)}
    fi
  `);

  console.log("Deploying production build");
  await execRemote(client, `
    set -e
    mkdir -p ${remoteQuote(config.appDir)} ${remoteQuote(`${config.appDir}/config`)}
    find ${remoteQuote(config.appDir)} -mindepth 1 -maxdepth 1 ! -name data ! -name config ! -name .env -exec rm -rf {} +
    find ${remoteQuote(`${config.appDir}/config`)} -mindepth 1 -maxdepth 1 ! -name watcher.local.json -exec rm -rf {} + 2>/dev/null || true
    cp -a ${remoteQuote(`${uploadRoot}/.`)} ${remoteQuote(`${config.appDir}/`)}
    rm -rf ${remoteQuote(uploadRoot)}
    cd ${remoteQuote(config.appDir)}
    docker compose up -d --build
  `);

  await execRemote(client, `
    set -e
    if [ -d ${remoteQuote(config.backupRoot)} ]; then
      mapfile -t backups < <(find ${remoteQuote(config.backupRoot)} -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
      if [ "\${#backups[@]}" -gt 3 ]; then
        for old in "\${backups[@]:3}"; do
          rm -rf ${remoteQuote(`${config.backupRoot}/`)}"$old"
        done
      fi
    fi
  `);

  const backups = await listRemoteBackups(client, config);
  console.log(`Production deploy finished. Current backup set: ${backups.join(", ") || "(none yet)"}`);
} finally {
  client.end();
}
