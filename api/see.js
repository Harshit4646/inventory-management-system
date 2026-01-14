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

    // 2️⃣ Query to see FULL database structure
    const structureQuery = `
      SELECT * FROM sales
    `;

    // 3️⃣ Execute query
    const result = await pool.query(structureQuery);

    // 4️⃣ Send structure as JSON
    res.json({
      success: true,
      total_rows: result.rows.length,
      structure: result.rows,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
