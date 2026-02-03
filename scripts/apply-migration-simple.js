const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({
  connectionString: 'postgresql://kiwoom_user:kiwoom@2026@localhost:15432/investment_db?schema=public'
});

async function applyMigration() {
  try {
    await client.connect();
    console.log('Connected to database');

    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '../prisma/migrations/20260203_add_stock_daily_metrics/migration.sql'),
      'utf-8'
    );

    console.log('Applying migration...');
    await client.query(migrationSQL);
    console.log('✅ Migration applied successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

applyMigration();
