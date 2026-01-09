import pkg from "pg";
const { Pool } = pkg;

export default async function handler(req, res) {
  console.log('=== Aiven Debug ===');
  console.log('DATABASE_URL length:', process.env.DATABASE_URL?.length || 0);
  console.log('DB host/port in URL:', process.env.DATABASE_URL?.split('@')[1]?.split('/')[0]?.split(':')[0] || 'NOT FOUND');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,  // 30s timeout
    statement_timeout: false,
  });

  try {
    console.log('Attempting connection...');
    const client = await pool.connect();
    console.log('✅ CONNECTED');
    
    const ver = await client.query('SELECT version()');
    console.log('Version:', ver.rows[0].version);
    client.release();

    // Create tables
    const queries = [ /* your exact table array */ ];
    for (let i = 0; i < queries.length; i++) {
      await pool.query(queries[i]);
      console.log(`Table ${i+1}/${queries.length} OK`);
    }

    res.json({ success: true, tables: queries.length });
  } catch (err) {
    console.error('ERROR CODE:', err.code);
    console.error('ERROR DETAIL:', err.message);
    console.error('STACK:', err.stack);
    res.status(500).json({ error: err.message, code: err.code });
  } finally {
    await pool.end();
  }
}




export default async function handler(req, res) {
  try {
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

    for (const q of queries) await pool.query(q);

    res.json({ success: true, message: "All tables created successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "SSL Connection failed: " + err.message });
  }
}
