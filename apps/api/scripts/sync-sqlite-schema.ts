import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pgPath = path.resolve(__dirname, '../prisma/schema.prisma');
const sqlitePath = path.resolve(__dirname, '../prisma/schema.sqlite.prisma');

const pgSchema = fs.readFileSync(pgPath, 'utf8');
if (!pgSchema.includes('provider = "postgresql"')) {
  throw new Error('Expected postgresql provider in schema.prisma');
}

const banner = `// AUTO-GENERATED FOR ACADEMIC SQLITE EVALUATION — DO NOT EDIT DIRECTLY\n// Source: apps/api/prisma/schema.prisma\n\n`;
const sqliteSchema =
  banner + pgSchema.replace('provider = "postgresql"', 'provider = "sqlite"');

fs.writeFileSync(sqlitePath, sqliteSchema, 'utf8');
console.log(`Synced SQLite schema -> ${sqlitePath}`);
