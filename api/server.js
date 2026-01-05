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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- helpers ----------
async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

let lastExpiredCheck = null;

async function moveExpiredStock() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastExpiredCheck === today) return;
  lastExpiredCheck = today;

  const expired = (
    await query(
      `SELECT s.id stock_id, s.product_id, s.quantity
       FROM stock s
       JOIN products p ON p.id = s.product_id
       WHERE p.expiry_date < $1`,
      [today]
    )
  ).rows;

  for (const r of expired) {
    if (r.quantity > 0) {
      await query(
        `INSERT INTO expired_stock (product_id, quantity, expired_date)
         VALUES ($1,$2,$3)`,
        [r.product_id, r.quantity, today]
      );
    }
    await query(`DELETE FROM stock WHERE id=$1`, [r.stock_id]);
  }
}

// ---------- API ----------
app.all("/api/server", async (req, res) => {
  const route = req.query.route;
  const today = new Date().toISOString().slice(0, 10);

  try {
    await moveExpiredStock();

    /* ---------------- DASHBOARD ---------------- */
    if (route === "dashboard") {
      const monthStart = today.slice(0, 7) + "-01";

      const q = async (sql, p = []) =>
        (await query(sql, p)).rows[0];

      return res.json({
        daily_total: q(`SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE sale_date::date=$1`, [today]).daily_total,
        monthly_total: q(`SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE sale_date::date BETWEEN $1 AND $2`, [monthStart, today]).monthly_total,
        daily_cash: q(`SELECT COALESCE(SUM(paid_amount),0) FROM sales WHERE sale_date::date=$1 AND payment_type='CASH'`, [today]).daily_cash,
        daily_online: q(`SELECT COALESCE(SUM(paid_amount),0) FROM sales WHERE sale_date::date=$1 AND payment_type='ONLINE'`, [today]).daily_online,
        daily_borrow: q(`SELECT COALESCE(SUM(borrow_amount),0) FROM sales WHERE sale_date::date=$1 AND payment_type='BORROW'`, [today]).daily_borrow,
        borrower_payments: q(`SELECT COALESCE(SUM(amount_paid),0) FROM borrower_payments WHERE payment_date::date=$1`, [today]).borrower_payments,
      });
    }

    /* ---------------- STOCK ---------------- */
    if (route === "stock") {
      if (req.method === "GET") {
        return res.json(
          (await query(
            `SELECT p.id,p.name,p.price,p.expiry_date,s.quantity
             FROM products p JOIN stock s ON s.product_id=p.id
             WHERE s.quantity>0 ORDER BY p.name`
          )).rows
        );
      }

      if (req.method === "POST") {
        const { name, price, expiry_date, quantity } = req.body;
        if (!name || !price || !expiry_date || !quantity)
          return res.status(400).json({ error: "Missing fields" });

        const c = await pool.connect();
        try {
          await c.query("BEGIN");

          const pid = (
            await c.query(
              `INSERT INTO products (name,price,expiry_date)
               VALUES ($1,$2,$3)
               RETURNING id`,
              [name, price, expiry_date]
            )
          ).rows[0].id;

          await c.query(
            `INSERT INTO stock (product_id,quantity)
             VALUES ($1,$2)
             ON CONFLICT (product_id)
             DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity`,
            [pid, quantity]
          );

          await c.query("COMMIT");
          return res.json({ success: true });
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      }
    }

    /* ---------------- SALE PRODUCTS ---------------- */
    if (route === "sale-products") {
      return res.json(
        (await query(
          `SELECT p.id,p.name,p.price,p.expiry_date,s.quantity
           FROM products p JOIN stock s ON s.product_id=p.id
           WHERE p.expiry_date >= $1 AND s.quantity>0`,
          [today]
        )).rows
      );
    }

    /* ---------------- SALES ---------------- */
    if (route === "sales") {

      /* GET */
      if (req.method === "GET") {
        return res.json(
          (await query(
            `SELECT * FROM sales ORDER BY sale_date DESC`
          )).rows
        );
      }

      /* POST - CREATE BILL */
      if (req.method === "POST") {
        const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;
        const borrow_amount = payment_type === "BORROW" ? total_amount - paid_amount : 0;

        const c = await pool.connect();
        try {
          await c.query("BEGIN");

          const saleId = (
            await c.query(
              `INSERT INTO sales
               (sale_date,customer_name,payment_type,total_amount,paid_amount,borrow_amount)
               VALUES (NOW(),$1,$2,$3,$4,$5) RETURNING id`,
              [customer_name, payment_type, total_amount, paid_amount, borrow_amount]
            )
          ).rows[0].id;

          for (const it of items) {
            await c.query(
              `INSERT INTO sale_items
               (sale_id,product_id,price,quantity,line_total)
               VALUES ($1,$2,$3,$4,$5)`,
              [saleId, it.product_id, it.price, it.quantity, it.price * it.quantity]
            );

            await c.query(
              `UPDATE stock SET quantity = quantity - $1 WHERE product_id=$2`,
              [it.quantity, it.product_id]
            );
          }

          if (borrow_amount > 0 && customer_name) {
            await c.query(
              `INSERT INTO borrowers (name,outstanding_amount)
               VALUES ($1,$2)
               ON CONFLICT (name)
               DO UPDATE SET outstanding_amount = borrowers.outstanding_amount + EXCLUDED.outstanding_amount`,
              [customer_name, borrow_amount]
            );
          }

          await c.query("COMMIT");
          return res.json({ success: true });
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      }

      /* PUT - EDIT BILL (items + new products) */
      if (req.method === "PUT") {
        const { id, customer_name, payment_type, paid_amount, items } = req.body;

        const c = await pool.connect();
        try {
          await c.query("BEGIN");

          const oldItems = (
            await c.query(
              `SELECT product_id,quantity FROM sale_items WHERE sale_id=$1`,
              [id]
            )
          ).rows;

          for (const it of oldItems) {
            await c.query(
              `UPDATE stock SET quantity = quantity + $1 WHERE product_id=$2`,
              [it.quantity, it.product_id]
            );
          }

          await c.query(`DELETE FROM sale_items WHERE sale_id=$1`, [id]);

          let total = 0;
          for (const it of items) {
            let pid = it.product_id;

            if (!pid) {
              pid = (
                await c.query(
                  `INSERT INTO products (name,price,expiry_date)
                   VALUES ($1,$2,$3) RETURNING id`,
                  [it.name, it.price, it.expiry_date]
                )
              ).rows[0].id;

              await c.query(
                `INSERT INTO stock (product_id,quantity) VALUES ($1,0)`,
                [pid]
              );
            }

            total += it.price * it.quantity;

            await c.query(
              `INSERT INTO sale_items
               (sale_id,product_id,price,quantity,line_total)
               VALUES ($1,$2,$3,$4,$5)`,
              [id, pid, it.price, it.quantity, it.price * it.quantity]
            );

            await c.query(
              `UPDATE stock SET quantity = quantity - $1 WHERE product_id=$2`,
              [it.quantity, pid]
            );
          }

          const borrow = payment_type === "BORROW" ? total - paid_amount : 0;

          await c.query(
            `UPDATE sales
             SET customer_name=$1,payment_type=$2,
                 total_amount=$3,paid_amount=$4,borrow_amount=$5
             WHERE id=$6`,
            [customer_name, payment_type, total, paid_amount, borrow, id]
          );

          await c.query("COMMIT");
          return res.json({ success: true });
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      }

      /* DELETE BILL */
      if (req.method === "DELETE") {
        const { id } = req.body;

        const c = await pool.connect();
        try {
          await c.query("BEGIN");

          const items = (
            await c.query(
              `SELECT product_id,quantity FROM sale_items WHERE sale_id=$1`,
              [id]
            )
          ).rows;

          for (const it of items) {
            await c.query(
              `UPDATE stock SET quantity = quantity + $1 WHERE product_id=$2`,
              [it.quantity, it.product_id]
            );
          }

          await c.query(`DELETE FROM sale_items WHERE sale_id=$1`, [id]);
          await c.query(`DELETE FROM sales WHERE id=$1`, [id]);

          await c.query("COMMIT");
          return res.json({ success: true });
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      }
    }

    /* ---------------- BORROWERS ---------------- */
    if (route === "borrowers") {
      return res.json(
        (await query(
          `SELECT id,name,outstanding_amount FROM borrowers WHERE outstanding_amount>0`
        )).rows
      );
    }

    /* ---------------- BORROWER PAYMENTS ---------------- */
    if (route === "borrower-payments" && req.method === "POST") {
      const { borrower_id, amount } = req.body;

      const c = await pool.connect();
      try {
        await c.query("BEGIN");

        await c.query(
          `INSERT INTO borrower_payments (borrower_id,amount_paid)
           VALUES ($1,$2)`,
          [borrower_id, amount]
        );

        await c.query(
          `UPDATE borrowers
           SET outstanding_amount = outstanding_amount - $1
           WHERE id=$2`,
          [amount, borrower_id]
        );

        let remaining = amount;
        const sales = (
          await c.query(
            `SELECT id,borrow_amount FROM sales
             WHERE customer_name = (SELECT name FROM borrowers WHERE id=$1)
             AND borrow_amount>0 ORDER BY sale_date`,
            [borrower_id]
          )
        ).rows;

        for (const s of sales) {
          if (remaining <= 0) break;
          const pay = Math.min(remaining, s.borrow_amount);

          await c.query(
            `UPDATE sales
             SET paid_amount = paid_amount + $1,
                 borrow_amount = borrow_amount - $1
             WHERE id=$2`,
            [pay, s.id]
          );
          remaining -= pay;
        }

        await c.query("COMMIT");
        return res.json({ success: true });
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }

    return res.status(404).json({ error: "Invalid route" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

export default app;
