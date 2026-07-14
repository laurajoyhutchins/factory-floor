#!/usr/bin/env node
import {
  createDatabase,
  migrateDown,
  migrateToLatest,
  resetDatabaseForDevelopment,
} from '../index.js';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const command = process.argv[2] ?? 'up';
const db = createDatabase(connectionString);
try {
  const result =
    command === 'up'
      ? await migrateToLatest(db)
      : command === 'down'
        ? await migrateDown(db)
        : command === 'reset'
          ? await resetDatabaseForDevelopment(db)
          : undefined;
  if (!result) throw new Error(`Unknown command: ${command}`);
  if (result.error) throw result.error;
  console.log(
    JSON.stringify(
      {
        command,
        migrations:
          result.results?.map(
            (r: { migrationName: string; status: string }) => ({
              migrationName: r.migrationName,
              status: r.status,
            }),
          ) ?? [],
      },
      null,
      2,
    ),
  );
} finally {
  await db.destroy();
}
