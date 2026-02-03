import { PrismaClient } from '../generated/prisma';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function applyMigration() {
  const migrationSQL = fs.readFileSync(
    path.join(__dirname, '../prisma/migrations/20260203_add_stock_daily_metrics/migration.sql'),
    'utf-8'
  );

  console.log('Applying migration...');

  try {
    await prisma.$executeRawUnsafe(migrationSQL);
    console.log('Migration applied successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

applyMigration();
