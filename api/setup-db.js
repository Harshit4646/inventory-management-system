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
      ca: getCa(),
      rejectUnauthorized: true,
    },
    max: 1,
  }));

export default async function handler(req, res) {
  try {
    // 1️⃣ Test DB connection
    await pool.query("SELECT 1");

    // 2️⃣ FIX ALL MISSING UNIQUE CONSTRAINTS
    const fixQueries = [

      // 🔹 PRODUCTS: allow ON CONFLICT (name)
      `
      ALTER TABLE products
      ADD CONSTRAINT IF NOT EXISTS unique_product_name
      UNIQUE (name);
      `,

      // 🔹 SALE ITEMS: allow ON CONFLICT (sale_id, product_id)
      `
      ALTER TABLE sale_items
      ADD CONSTRAINT IF NOT EXISTS unique_sale_product
      UNIQUE (sale_id, product_id);
      `,

      // 🔹 EXPIRED STOCK: allow ON CONFLICT (product_id, expired_date)
      `
      ALTER TABLE expired_stock
      ADD CONSTRAINT IF NOT EXISTS unique_expired_product_date
      UNIQUE (product_id, expired_date);
      `
    ];

    // 3️⃣ Execute fixes
    for (const q of fixQueries) {
      await pool.query(q);
    }

    // 4️⃣ Return success
    res.json({
      success: true,
      message: "ON CONFLICT error permanently fixed",
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
