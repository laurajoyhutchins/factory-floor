import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import type { Database } from './database.js';

function migrator(db: Kysely<Database>) {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'migrations',
      ),
    }),
  });
}
export async function migrateToLatest(db: Kysely<Database>) {
  return migrator(db).migrateToLatest();
}
export async function migrateDown(db: Kysely<Database>) {
  return migrator(db).migrateDown();
}
export async function resetDatabaseForDevelopment(
  db: Kysely<Database>,
  env = process.env.NODE_ENV,
) {
  if (env !== 'development' && env !== 'test')
    throw new Error(
      'Database reset is restricted to development and test environments',
    );
  let result = await migrateDown(db);
  while (!result.error && result.results?.some((r) => r.status === 'Success'))
    result = await migrateDown(db);
  if (result.error) throw result.error;
  const up = await migrateToLatest(db);
  if (up.error) throw up.error;
  return up;
}
export async function loadMigrationModule(name: string) {
  return import(
    pathToFileURL(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'migrations',
        name,
      ),
    ).href
  );
}
