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
    // 1️⃣ Test connection
    await pool.query("SELECT 1");

    // 2️⃣ SAFE constraint fixes (PostgreSQL-compatible)
    const fixQuery = `
    DO $$
DECLARE
  c RECORD;
BEGIN
  /* ---------- PRODUCTS ---------- */
  -- Drop any wrong unique constraint on products except the correct one
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'products'::regclass
      AND contype = 'u'
      AND conname <> 'unique_product_full'
  LOOP
    EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', c.conname);
  END LOOP;

  -- Add correct composite unique if missing
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_product_full'
  ) THEN
    ALTER TABLE products
    ADD CONSTRAINT unique_product_full
    UNIQUE (name, price, expiry_date);
  END IF;


  /* ---------- SALE ITEMS ---------- */
  -- Drop ALL wrong unique constraints
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'sale_items'::regclass
      AND contype = 'u'
      AND conname <> 'unique_sale_product_pair'
  LOOP
    EXECUTE format('ALTER TABLE sale_items DROP CONSTRAINT %I', c.conname);
  END LOOP;

  -- Add correct composite unique
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_sale_product_pair'
  ) THEN
    ALTER TABLE sale_items
    ADD CONSTRAINT unique_sale_product_pair
    UNIQUE (sale_id, product_id);
  END IF;


  /* ---------- EXPIRED STOCK ---------- */
  -- Drop wrong unique constraints
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'expired_stock'::regclass
      AND contype = 'u'
      AND conname <> 'unique_expired_pair'
  LOOP
    EXECUTE format('ALTER TABLE expired_stock DROP CONSTRAINT %I', c.conname);
  END LOOP;

  -- Add correct composite unique
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_expired_pair'
  ) THEN
    ALTER TABLE expired_stock
    ADD CONSTRAINT unique_expired_pair
    UNIQUE (product_id, expired_date);
  END IF;

END
$$;

    `;

    // 3️⃣ Execute fix
    await pool.query(fixQuery);

    // 4️⃣ Success response
    res.json({
      success: true,
      message: "ON CONFLICT error fixed safely (PostgreSQL compatible)",
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
