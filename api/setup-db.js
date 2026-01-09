import pkg from "pg";
const { Pool } = pkg;

export default async function handler(req, res) {
  console.log('=== DEBUG START ===');
  console.log('DATABASE_URL length:', process.env.DATABASE_URL?.length);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
  });

  try {
    const result = await pool.query('SELECT 1 AS ping');
    console.log('✅ PING SUCCESS');

    const queries = [
      `CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        expiry_date DATE NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS stock (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS expired_stock (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id),
        quantity INTEGER NOT NULL,
        expired_date DATE NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        sale_date TIMESTAMP DEFAULT NOW(),
        customer_name TEXT,
        payment_type TEXT CHECK (payment_type IN ('CASH','ONLINE','BORROW')),
        total_amount NUMERIC(10,2) DEFAULT 0,
        discount_amount NUMERIC(10,2) DEFAULT 0,
        paid_amount NUMERIC(10,2) DEFAULT 0,
        borrow_amount NUMERIC(10,2) DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        price NUMERIC(10,2),
        quantity INTEGER,
        line_total NUMERIC(10,2)
      )`,
      `CREATE TABLE IF NOT EXISTS borrowers (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        outstanding_amount NUMERIC(10,2) DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS borrower_payments (
        id SERIAL PRIMARY KEY,
        borrower_id INTEGER REFERENCES borrowers(id),
        amount_paid NUMERIC(10,2),
        payment_date TIMESTAMP DEFAULT NOW()
      )`,
    ];

    for (const [i, q] of queries.entries()) {
      await pool.query(q);
      console.log(`Table ${i+1} created`);
    }

    res.json({ success: true, message: "Tables ready" });
  } catch (err) {
    console.error('ERROR:', err.code, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
}
