import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { join } from 'node:path';

function sanitize(text) {
  return text
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(
      /postgres(?:ql)?:\/\/([^:/\s]+):([^@/\s]+)@/gi,
      'postgres://$1:[REDACTED]@',
    )
    .replace(/(leaseToken=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/("leaseToken"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/("lease_token"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(
      /(authorization\s*[:=]\s*["']?Bearer\s+)[^\s"',}]+/gi,
      '$1[REDACTED]',
    );
}

async function filesAt(path) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata) return [];
  if (metadata.isFile()) return [path];
  if (!metadata.isDirectory()) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => filesAt(join(path, entry.name))),
  );
  return nested.flat();
}

const targets = process.argv.slice(2);
if (targets.length === 0)
  throw new Error(
    'provide at least one evidence file or directory to sanitize',
  );

let changed = 0;
for (const target of targets) {
  for (const path of await filesAt(target)) {
    const input = await readFile(path, 'utf8').catch(() => null);
    if (input === null) continue;
    const output = sanitize(input);
    if (output === input) continue;
    await writeFile(path, output);
    changed += 1;
  }
}

globalThis.console.log(
  JSON.stringify({ status: 'sanitized', targets, changedFiles: changed }),
);
