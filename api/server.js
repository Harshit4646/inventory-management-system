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

// Postgres connection pool (serverless-safe if reused globally)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Helper: simple query wrapper
async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

let lastExpiredCheck = null;

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

// helper: recompute total & borrow for a sale
async function recomputeSaleTotals(client, saleId) {
  const itemsRes = await client.query(
    `SELECT quantity, price FROM sale_items WHERE sale_id = $1`,
    [saleId]
  );
  let total = 0;
  for (const it of itemsRes.rows) {
    total += Number(it.price) * Number(it.quantity);
  }

  const saleRes = await client.query(
    `SELECT payment_type, paid_amount FROM sales WHERE id = $1`,
    [saleId]
  );
  const sale = saleRes.rows[0];
  const paid = Number(sale.paid_amount);
  const paymentType = sale.payment_type;

  let borrow_amount = 0;
  if (paymentType === "BORROW") {
    borrow_amount = total - paid;
    if (borrow_amount < 0) borrow_amount = 0;
  }

  await client.query(
    `UPDATE sales SET total_amount = $1, borrow_amount = $2 WHERE id = $3`,
    [total, borrow_amount, saleId]
  );

  return { total, borrow_amount, paymentType, paid };
}

// helper: update borrower outstanding based on all its sales
async function syncBorrowerOutstanding(client, borrowerName) {
  const borrowerRes = await client.query(
    `SELECT id FROM borrowers WHERE name = $1`,
    [borrowerName]
  );
  if (borrowerRes.rows.length === 0) return;

  const borrowerId = borrowerRes.rows[0].id;

  const borrowSumRes = await client.query(
    `SELECT COALESCE(SUM(borrow_amount),0) AS total_borrow
     FROM sales
     WHERE customer_name = $1`,
    [borrowerName]
  );
  const totalBorrow = Number(borrowSumRes.rows[0].total_borrow);

  if (totalBorrow <= 0) {
  await client.query(
    `UPDATE borrowers
     SET outstanding_amount = 0
     WHERE id = $1`,
    [borrowerId]
  );
} else {
  await client.query(
    `UPDATE borrowers
     SET outstanding_amount = $1
     WHERE id = $2`,
    [totalBorrow, borrowerId]
  );
}

}

// main handler
app.all("/api/server", async (req, res) => {
  const route = req.query.route;

  try {
    await moveExpiredStock();
    const today = new Date().toISOString().slice(0, 10);

    /* ------------ DASHBOARD ------------ */
    if (route === "dashboard") {
      const monthStart = today.slice(0, 7) + "-01";

      const daily_total = (
  await query(
    `SELECT COALESCE(SUM(total_amount),0) AS daily_total
     FROM sales
     WHERE sale_date::date = $1
       AND payment_type IN ('CASH','ONLINE')`,
    [today]
  )
).rows[0].daily_total;

const monthly_total = (
  await query(
    `SELECT COALESCE(SUM(total_amount),0) AS monthly_total
     FROM sales
     WHERE sale_date::date BETWEEN $1 AND $2
       AND payment_type IN ('CASH','ONLINE')`,
    [monthStart, today]
  )
).rows[0].monthly_total;


      const daily_cash = (
        await query(
          `SELECT COALESCE(SUM(paid_amount),0) AS daily_cash
           FROM sales WHERE sale_date::date = $1 AND payment_type = 'CASH'`,
          [today]
        )
      ).rows[0].daily_cash;

      const daily_online = (
        await query(
          `SELECT COALESCE(SUM(paid_amount),0) AS daily_online
           FROM sales WHERE sale_date::date = $1 AND payment_type = 'ONLINE'`,
          [today]
        )
      ).rows[0].daily_online;

      const daily_borrow = (
        await query(
          `SELECT COALESCE(SUM(borrow_amount),0) AS daily_borrow
           FROM sales WHERE sale_date::date = $1 AND payment_type = 'BORROW'`,
          [today]
        )
      ).rows[0].daily_borrow;

      const borrower_payments = (
        await query(
          `SELECT COALESCE(SUM(amount_paid),0) AS borrower_payments
           FROM borrower_payments WHERE payment_date::date = $1`,
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

    /* ------------ STOCK ------------ */
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
        if (!name || !price || !expiry_date || !quantity) {
          return res.status(400).json({ error: "Missing fields" });
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          const productRes = await client.query(
            `INSERT INTO products (name, price, expiry_date)
             VALUES ($1, $2, $3)
             ON CONFLICT (name, price, expiry_date)
             DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [name, price, expiry_date]
          );
          const pid = productRes.rows[0].id;

          const existingRes = await client.query(
            `SELECT * FROM stock WHERE product_id = $1`,
            [pid]
          );
          if (existingRes.rows.length === 0) {
            await client.query(
              `INSERT INTO stock (product_id, quantity)
               VALUES ($1, $2)`,
              [pid, quantity]
            );
          } else {
            await client.query(
              `UPDATE stock SET quantity = quantity + $1
               WHERE product_id = $2`,
              [quantity, pid]
            );
          }

          await client.query("COMMIT");
          return res.json({ success: true });
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
    }

    /* ------------ EXPIRED ------------ */
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

    /* ------------ SALE PRODUCTS ------------ */
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

    /* ------------ SALES (LIST + CREATE) ------------ */
    if (route === "sales") {
      if (req.method === "GET") {
        const rows = (
          await query(
            `SELECT id, sale_date::date AS date, customer_name,
                    payment_type, total_amount, discount_amount, paid_amount, borrow_amount
             FROM sales
             ORDER BY sale_date DESC`
          )
        ).rows;
        return res.json(rows);
      }

      if (req.method === "POST") {
        const { customer_name, payment_type, items, total_amount, discount_amount, paid_amount } = req.body;
        if (!items || items.length === 0) {
          return res.status(400).json({ error: "No sale items" });
        }

        const borrow_amount =
          payment_type === "BORROW" ? total_amount - paid_amount : 0;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          const saleRes = await client.query(
            `INSERT INTO sales
             (sale_date, customer_name, payment_type, total_amount, discount_amount, paid_amount, borrow_amount)
             VALUES (NOW(), $1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [customer_name, payment_type, total_amount, discount_amount, paid_amount, borrow_amount]
          );
          const saleId = saleRes.rows[0].id;

          for (const it of items) {
            await client.query(
              `UPDATE stock SET quantity = quantity - $1
               WHERE product_id = $2`,
              [it.quantity, it.product_id]
            );
            await client.query(
              `INSERT INTO sale_items
                 (sale_id, product_id, price, quantity, line_total)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                saleId,
                it.product_id,
                it.price,
                it.quantity,
                it.price * it.quantity,
              ]
            );
          }

          if (borrow_amount > 0 && customer_name) {
            const borrowerRes = await client.query(
              `SELECT * FROM borrowers WHERE name = $1`,
              [customer_name]
            );
            if (borrowerRes.rows.length === 0) {
              await client.query(
                `INSERT INTO borrowers (name, outstanding_amount)
                 VALUES ($1, $2)`,
                [customer_name, borrow_amount]
              );
            } else {
              await client.query(
                `UPDATE borrowers
                 SET outstanding_amount = outstanding_amount + $1
                 WHERE id = $2`,
                [borrow_amount, borrowerRes.rows[0].id]
              );
            }
          }

          await client.query("COMMIT");
          return res.json({ success: true, sale_id: saleId });
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
    }

    /* ------------ VIEW BILL DETAIL ------------ */
    if (route === "bill-detail" && req.method === "GET") {
      const saleId = req.query.sale_id;
      if (!saleId) {
        return res.status(400).json({ error: "sale_id required" });
      }

      const saleRes = await query(
        `SELECT id, sale_date, customer_name, payment_type,
                total_amount, discount_amount, paid_amount, borrow_amount
         FROM sales WHERE id = $1`,
        [saleId]
      );
      if (saleRes.rows.length === 0) {
        return res.status(404).json({ error: "Sale not found" });
      }
      const sale = saleRes.rows[0];

      const itemsRes = await query(
        `SELECT si.id, si.product_id, p.name, si.price, si.quantity,
                si.line_total
         FROM sale_items si
         JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = $1`,
        [saleId]
      );

      return res.json({
        sale,
        items: itemsRes.rows,
      });
    }

    /* ------------ EDIT BILL ------------ */
    if (route === "edit-bill" && req.method === "POST") {
      const {
        sale_id,
        customer_name,
        payment_type,
        discount_amount,
        paid_amount,
        items, // full array: {sale_item_id or null, product_id, qty}
      } = req.body;

      if (!sale_id || !items || !Array.isArray(items)) {
        return res.status(400).json({ error: "Missing sale_id or items" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const saleRes = await client.query(
          `SELECT * FROM sales WHERE id = $1`,
          [sale_id]
        );
        if (saleRes.rows.length === 0) {
          throw new Error("Sale not found");
        }
        const oldSale = saleRes.rows[0];
        const oldCustomer = oldSale.customer_name;
        const oldPaymentType = oldSale.payment_type;

        // 1) restore stock from current sale_items
        const oldItemsRes = await client.query(
          `SELECT * FROM sale_items WHERE sale_id = $1`,
          [sale_id]
        );
        for (const it of oldItemsRes.rows) {
          await client.query(
            `UPDATE stock SET quantity = quantity + $1
             WHERE product_id = $2`,
            [it.quantity, it.product_id]
          );
        }

        // 2) delete old sale_items
        await client.query(`DELETE FROM sale_items WHERE sale_id = $1`, [
          sale_id,
        ]);

        // 3) insert new sale_items and adjust stock
        for (const it of items) {
          const qty = Number(it.quantity);
          if (qty <= 0) continue;

          const productId = it.product_id;
          const priceRes = await client.query(
            `SELECT price FROM products WHERE id = $1`,
            [productId]
          );
          if (priceRes.rows.length === 0) {
            throw new Error("Invalid product in edit");
          }
          const price = Number(priceRes.rows[0].price);

          await client.query(
            `UPDATE stock SET quantity = quantity - $1
             WHERE product_id = $2`,
            [qty, productId]
          );

          await client.query(
            `INSERT INTO sale_items
               (sale_id, product_id, price, quantity, line_total)
             VALUES ($1, $2, $3, $4, $5)`,
            [sale_id, productId, price, qty, price * qty]
          );
        }

        // 4) update sale header (name, payment_type, paid_amount)
        await client.query(
          `UPDATE sales
           SET customer_name = $1,
               payment_type = $2,
               discount_amount = $3,
               paid_amount = $4
           WHERE id = $5`,
          [customer_name, payment_type, discount_amount, paid_amount, sale_id]
        );

        // 5) recompute total & borrow for this sale
        const { total, borrow_amount } = await recomputeSaleTotals(
          client,
          sale_id
        );

        // 6) sync borrowers for old and new customer if needed
        if (oldCustomer && oldCustomer !== customer_name) {
          await syncBorrowerOutstanding(client, oldCustomer);
        }
        if (customer_name) {
          await syncBorrowerOutstanding(client, customer_name);
        }

        await client.query("COMMIT");
        return res.json({ success: true, total, borrow_amount });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Edit bill error:", err);
        return res.status(500).json({ error: err.message });
      } finally {
        client.release();
      }
    }

    /* ------------ DELETE BILL ------------ */
    if (route === "delete-bill" && req.method === "POST") {
      const { sale_id } = req.body;
      if (!sale_id) {
        return res.status(400).json({ error: "sale_id required" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const saleRes = await client.query(
          `SELECT * FROM sales WHERE id = $1`,
          [sale_id]
        );
        if (saleRes.rows.length === 0) {
          throw new Error("Sale not found");
        }
        const sale = saleRes.rows[0];
        const custName = sale.customer_name;

        // restore stock
        const itemsRes = await client.query(
          `SELECT product_id, quantity FROM sale_items WHERE sale_id = $1`,
          [sale_id]
        );
        for (const it of itemsRes.rows) {
          await client.query(
            `UPDATE stock SET quantity = quantity + $1
             WHERE product_id = $2`,
            [it.quantity, it.product_id]
          );
        }

        // delete sale_items and sale
        await client.query(`DELETE FROM sale_items WHERE sale_id = $1`, [
          sale_id,
        ]);
        await client.query(`DELETE FROM sales WHERE id = $1`, [sale_id]);

        if (custName) {
          await syncBorrowerOutstanding(client, custName);
        }

        await client.query("COMMIT");
        return res.json({ success: true });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Delete bill error:", err);
        return res.status(500).json({ error: err.message });
      } finally {
        client.release();
      }
    }

        /* ------------ BILLS (LIST) ------------ */
    if (route === "bills" && req.method === "GET") {
      const rows = (
        await query(
          `SELECT
             id,
             sale_date,
             customer_name,
             payment_type,
             total_amount,
             discount_amount,
             paid_amount,
             borrow_amount
           FROM sales
           ORDER BY sale_date DESC, id DESC`
        )
      ).rows;
      return res.json(rows);
    }


    /* ------------ BORROWERS & PAYMENTS ------------ */
    if (route === "borrowers" && req.method === "GET") {
      const rows = (
        await query(
          `SELECT id, name, outstanding_amount
           FROM borrowers
           WHERE outstanding_amount > 0
           ORDER BY name`
        )
      ).rows;
      return res.json(rows);
    }

    if (route === "borrower-payments" && req.method === "POST") {
      const { borrower_id, amount } = req.body;
      if (!borrower_id || !amount) {
        return res.status(400).json({ error: "Missing fields" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // find borrower and name
        const bRes = await client.query(
          `SELECT id, name FROM borrowers WHERE id = $1`,
          [borrower_id]
        );
        if (bRes.rows.length === 0) {
          throw new Error("Borrower not found");
        }
        const borrowerName = bRes.rows[0].name;

        await client.query(
          `INSERT INTO borrower_payments (borrower_id, amount_paid)
           VALUES ($1, $2)`,
          [borrower_id, amount]
        );

        // reduce outstanding
        await client.query(
          `UPDATE borrowers
           SET outstanding_amount = outstanding_amount - $1
           WHERE id = $2`,
          [amount, borrower_id]
        );

        // Apply payment FIFO to related sales
        let remaining = Number(amount);
        const salesRes = await client.query(
          `SELECT id, borrow_amount
           FROM sales
           WHERE customer_name = $1 AND borrow_amount > 0
           ORDER BY sale_date ASC`,
          [borrowerName]
        );

        for (const s of salesRes.rows) {
          if (remaining <= 0) break;
          const apply = Math.min(remaining, Number(s.borrow_amount));
          await client.query(
            `UPDATE sales
             SET paid_amount = paid_amount + $1,
                 borrow_amount = borrow_amount - $1
             WHERE id = $2`,
            [apply, s.id]
          );
          remaining -= apply;
        }

        // sync borrower outstanding based on sales
        await syncBorrowerOutstanding(client, borrowerName);

        await client.query("COMMIT");
        return res.json({ success: true });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(err);
        return res.status(500).json({ error: "Payment failed: " + err.message });
      } finally {
        client.release();
      }
    }

    // default
    return res.status(404).json({ error: "Invalid route" });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default app;



