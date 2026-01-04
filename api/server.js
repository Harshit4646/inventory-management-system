// api/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// Postgres connection pool (Serverless-safe)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Helper: query wrapper
async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// Prevent repeated expired stock move per day
let lastExpiredCheck = null;

// Move expired stock
async function moveExpiredStock() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastExpiredCheck === today) return;
  lastExpiredCheck = today;

  const expiredRows = (
    await query(
      `SELECT s.id AS stock_id, s.product_id, s.quantity
       FROM stock s
       JOIN products p ON p.id = s.product_id
       WHERE p.expiry_date < $1`,
      [today]
    )
  ).rows;

  for (const row of expiredRows) {
    if (row.quantity > 0) {
      await query(
        `INSERT INTO expired_stock (product_id, quantity, expired_date)
         VALUES ($1, $2, $3)`,
        [row.product_id, row.quantity, today]
      );
    }
    await query(`DELETE FROM stock WHERE id = $1`, [row.stock_id]);
  }
}

// Single API endpoint
app.all("/api/server", async (req, res) => {
  const route = req.query.route;

  try {
    await moveExpiredStock();
    const today = new Date().toISOString().slice(0, 10);

    /* ---------------- DASHBOARD ---------------- */
    if (route === "dashboard") {
      const monthStart = today.slice(0, 7) + "-01";

      const daily_total = (
        await query(`SELECT COALESCE(SUM(total_amount),0) AS daily_total FROM sales WHERE sale_date::date = $1`, [today])
      ).rows[0].daily_total;

      const monthly_total = (
        await query(
          `SELECT COALESCE(SUM(total_amount),0) AS monthly_total FROM sales WHERE sale_date::date BETWEEN $1 AND $2`,
          [monthStart, today]
        )
      ).rows[0].monthly_total;

      const daily_cash = (
        await query(
          `SELECT COALESCE(SUM(paid_amount),0) AS daily_cash FROM sales WHERE sale_date::date = $1 AND payment_type='CASH'`,
          [today]
        )
      ).rows[0].daily_cash;

      const daily_online = (
        await query(
          `SELECT COALESCE(SUM(paid_amount),0) AS daily_online FROM sales WHERE sale_date::date = $1 AND payment_type='ONLINE'`,
          [today]
        )
      ).rows[0].daily_online;

      const daily_borrow = (
        await query(
          `SELECT COALESCE(SUM(borrow_amount),0) AS daily_borrow FROM sales WHERE sale_date::date = $1 AND payment_type='BORROW'`,
          [today]
        )
      ).rows[0].daily_borrow;

      const borrower_payments = (
        await query(
          `SELECT COALESCE(SUM(amount_paid),0) AS borrower_payments FROM borrower_payments WHERE payment_date::date = $1`,
          [today]
        )
      ).rows[0].borrower_payments;

      return res.json({
        daily_total,
        monthly_total,
        daily_cash,
        daily_online,
        daily_borrow,
        borrower_payments,
      });
    }

    /* ---------------- STOCK ---------------- */
    if (route === "stock") {
      if (req.method === "GET") {
        const rows = (
          await query(
            `SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
             FROM products p
             JOIN stock s ON s.product_id = p.id
             WHERE s.quantity > 0
             ORDER BY p.name`
          )
        ).rows;
        return res.json(rows);
      }

      if (req.method === "POST") {
        const { name, price, expiry_date, quantity } = req.body;
        if (!name || !price || !expiry_date || !quantity)
          return res.status(400).json({ error: "Missing fields" });

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          const productRes = await client.query(
            `INSERT INTO products (name, price, expiry_date)
             VALUES ($1, $2, $3)
             ON CONFLICT (name, price, expiry_date) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [name, price, expiry_date]
          );
          const pid = productRes.rows[0].id;

          const existingRes = await client.query(`SELECT * FROM stock WHERE product_id = $1`, [pid]);
          if (existingRes.rows.length === 0) {
            await client.query(`INSERT INTO stock (product_id, quantity) VALUES ($1, $2)`, [pid, quantity]);
          } else {
            await client.query(`UPDATE stock SET quantity = quantity + $1 WHERE product_id = $2`, [quantity, pid]);
          }

          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }

        return res.json({ success: true });
      }
    }

    /* ---------------- EXPIRED ---------------- */
    if (route === "expired") {
      const rows = (
        await query(
          `SELECT p.name, p.price, p.expiry_date, e.quantity, e.expired_date
           FROM expired_stock e
           JOIN products p ON p.id = e.product_id
           ORDER BY e.expired_date DESC`
        )
      ).rows;
      return res.json(rows);
    }

    /* ---------------- SALE PRODUCTS ---------------- */
    if (route === "sale-products") {
      const rows = (
        await query(
          `SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
           FROM products p
           JOIN stock s ON s.product_id = p.id
           WHERE p.expiry_date >= $1 AND s.quantity > 0
           ORDER BY p.name`,
          [today]
        )
      ).rows;
      return res.json(rows);
    }

    /* ---------------- SALES ---------------- */
    if (route === "sales") {
      if (req.method === "GET") {
        const rows = (await query(
          `SELECT sale_date::date AS date, customer_name, payment_type, total_amount, paid_amount, borrow_amount
           FROM sales ORDER BY sale_date DESC`
        )).rows;
        return res.json(rows);
      }

      if (req.method === "POST") {
        const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: "No sale items" });

        const borrow_amount = payment_type === "BORROW" ? total_amount - paid_amount : 0;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          const saleRes = await client.query(
            `INSERT INTO sales (sale_date, customer_name, payment_type, total_amount, paid_amount, borrow_amount)
             VALUES (NOW(), $1, $2, $3, $4, $5) RETURNING id`,
            [customer_name, payment_type, total_amount, paid_amount, borrow_amount]
          );
          const saleId = saleRes.rows[0].id;

          for (const it of items) {
            await client.query(`UPDATE stock SET quantity = quantity - $1 WHERE product_id = $2`, [
              it.quantity,
              it.product_id,
            ]);
            await client.query(
              `INSERT INTO sale_items (sale_id, product_id, price, quantity, line_total)
               VALUES ($1, $2, $3, $4, $5)`,
              [saleId, it.product_id, it.price, it.quantity, it.price * it.quantity]
            );
          }

          if (borrow_amount > 0 && customer_name) {
            const borrowerRes = await client.query(`SELECT * FROM borrowers WHERE name = $1`, [customer_name]);
            if (borrowerRes.rows.length === 0) {
              await client.query(`INSERT INTO borrowers (name, outstanding_amount) VALUES ($1, $2)`, [
                customer_name,
                borrow_amount,
              ]);
            } else {
              await client.query(
                `UPDATE borrowers SET outstanding_amount = outstanding_amount + $1 WHERE id = $2`,
                [borrow_amount, borrowerRes.rows[0].id]
              );
            }
          }

          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }

        return res.json({ success: true });
      }
    }

    /* ---------------- BORROWERS ---------------- */
    if (route === "borrowers") {
      const rows = (await query(`SELECT id, name, outstanding_amount FROM borrowers WHERE outstanding_amount > 0 ORDER BY name`)).rows;
      return res.json(rows);
    }

    if (route === "borrower-payments" && req.method === "POST") {
  const { borrower_id, amount } = req.body;
  if (!borrower_id || !amount)
    return res.status(400).json({ error: "Missing fields" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1️⃣ Save payment
    await client.query(
      `INSERT INTO borrower_payments (borrower_id, amount_paid)
       VALUES ($1, $2)`,
      [borrower_id, amount]
    );

    // 2️⃣ Reduce borrower outstanding
    await client.query(
      `UPDATE borrowers
       SET outstanding_amount = outstanding_amount - $1
       WHERE id = $2`,
      [amount, borrower_id]
    );

    // 3️⃣ APPLY PAYMENT TO SALES (FIFO)
    let remaining = amount;

    const sales = await client.query(
      `SELECT id, borrow_amount
       FROM sales
       WHERE customer_name = (
         SELECT name FROM borrowers WHERE id = $1
       )
       AND borrow_amount > 0
       ORDER BY sale_date ASC`,
      [borrower_id]
    );

    for (const sale of sales.rows) {
      if (remaining <= 0) break;

      const apply = Math.min(remaining, sale.borrow_amount);

      await client.query(
        `UPDATE sales
         SET
           paid_amount = paid_amount + $1,
           borrow_amount = borrow_amount - $1
         WHERE id = $2`,
        [apply, sale.id]
      );

      remaining -= apply;
    }

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({ error: "Payment failed" });
  } finally {
    client.release();
  }
}



    return res.status(404).json({ error: "Invalid route" });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default app;


