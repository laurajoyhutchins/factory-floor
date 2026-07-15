import { FilesystemArtifactBlobStore } from '@factory-floor/artifact-store';
import { ArtifactRepository, createDatabase } from '@factory-floor/db';
import { ArtifactReconciliationService } from '@factory-floor/runtime-core';

function option(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed?.slice(flag.length + 1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const artifactRoot = process.env.ARTIFACT_STORE_ROOT ?? '.factory-floor/artifacts';
const db = createDatabase(databaseUrl);
try {
  const service = new ArtifactReconciliationService({ db, repository: new ArtifactRepository(), blobStore: new FilesystemArtifactBlobStore(artifactRoot) });
  const report = await service.runBatch({
    limit: Number(option('limit') ?? 100),
    cursor: option('cursor'),
    removeOrphans: process.argv.includes('--remove-orphans'),
    orphanGraceSeconds: Number(option('orphan-grace-seconds') ?? 3600),
  });
  console.log(JSON.stringify({ dryRun: process.argv.includes('--dry-run') || !process.argv.includes('--remove-orphans'), report }, null, 2));
} finally {
  await db.destroy();
}
