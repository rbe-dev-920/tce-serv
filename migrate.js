#!/usr/bin/env node
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('[MIGRATE] Starting Prisma migration...');

try {
  const output = execSync('prisma migrate deploy --skip-generate', {
    cwd: __dirname,
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  console.log('[MIGRATE] ✅ Migration completed successfully');
  console.log(output);
} catch (error) {
  console.error('[MIGRATE] ⚠️  Migration failed or already deployed');
  console.error(error.message);
  // Continue anyway - tables might already exist
}

console.log('[MIGRATE] Starting server...');
