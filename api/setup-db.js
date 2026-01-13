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
       `ALTER TABLE stock
ADD CONSTRAINT unique_product_stock UNIQUE (product_id);
`,
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
