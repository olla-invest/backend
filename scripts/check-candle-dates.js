const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://kiwoom_user:kiwoom@2026@localhost:15432/investment_db?schema=public'
});

async function checkDates() {
  try {
    await client.connect();

    // Get distinct candle dates
    const result = await client.query(`
      SELECT DISTINCT DATE(candle_time) as trade_date, COUNT(*) as stock_count
      FROM stock_candles
      WHERE candle_type = 'day'
      GROUP BY DATE(candle_time)
      ORDER BY trade_date DESC
      LIMIT 10
    `);

    console.log('Available candle dates:');
    console.log(JSON.stringify(result.rows, null, 2));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

checkDates();
