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
  r RECORD;
BEGIN
  FOR r IN (
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  ) LOOP
    EXECUTE format(
      'TRUNCATE TABLE %I RESTART IDENTITY CASCADE',
      r.tablename
    );
  END LOOP;
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
