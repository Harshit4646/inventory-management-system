import pkg from "pg";
const { Pool } = pkg;

function getCa() {
  return process.env.PG_CA?.replace(/\\n/g, "\n");
}

const pool =
  globalThis.__pool ||
  (globalThis.__pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      ca: getCa(),              // ✅ trust Aiven CA
      rejectUnauthorized: true, // ✅ now SAFE
    },
    max: 1,
  }));

export default async function handler(req, res) {
  try {
    // 1️⃣ Test connection
    await pool.query("SELECT 1");

    // 2️⃣ Your SQL queries go here
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

    // 3️⃣ Execute queries
    for (const q of queries) {
      await pool.query(q);
    }

    // 4️⃣ Send response
    res.json({ success: true, message: "Tables created" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
