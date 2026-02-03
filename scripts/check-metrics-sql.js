const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://kiwoom_user:kiwoom@2026@localhost:15432/investment_db?schema=public'
});

async function checkMetrics() {
  try {
    await client.connect();

    // Check total count
    const countResult = await client.query('SELECT COUNT(*) FROM stock_daily_metrics');
    console.log('Total metrics:', countResult.rows[0].count);

    // Get sample data
    const sampleResult = await client.query(`
      SELECT stock_code, trade_date, close_price, relative_strength_score, rank, is_new_high
      FROM stock_daily_metrics
      ORDER BY trade_date DESC, rank ASC
      LIMIT 10
    `);

    console.log('\nSample metrics:');
    console.log(JSON.stringify(sampleResult.rows, null, 2));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

checkMetrics();
