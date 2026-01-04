// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Connect to Postgres
const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false } // required for Vercel / hosted Postgres
});

// Prevent running moveExpiredStock multiple times per day
let lastExpiredCheck = null;

async function moveExpiredStock() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastExpiredCheck === today) return;
  lastExpiredCheck = today;

  const expiredRows = await sql`
    SELECT s.id AS stock_id, s.product_id, s.quantity
    FROM stock s
    JOIN products p ON p.id = s.product_id
    WHERE p.expiry_date < ${today}
  `;
  for (const row of expiredRows) {
    if (row.quantity > 0) {
      await sql`
        INSERT INTO expired_stock (product_id, quantity, expired_date)
        VALUES (${row.product_id}, ${row.quantity}, ${today})
      `;
    }
    await sql`DELETE FROM stock WHERE id = ${row.stock_id}`;
  }
}

app.all("/api/server", async (req, res) => {
  const route = req.query.route;

  try {
    // Move expired stock first
    await moveExpiredStock();

    /* ---------------- DASHBOARD ---------------- */
    if (route === "dashboard") {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + "-01";

      const [{ daily_total }] = await sql`
        SELECT COALESCE(SUM(total_amount),0) AS daily_total
        FROM sales WHERE sale_date::date = ${today}
      `;
      const [{ monthly_total }] = await sql`
        SELECT COALESCE(SUM(total_amount),0) AS monthly_total
        FROM sales WHERE sale_date::date BETWEEN ${monthStart} AND ${today}
      `;
      const [{ daily_cash }] = await sql`
        SELECT COALESCE(SUM(paid_amount),0) AS daily_cash
        FROM sales WHERE sale_date::date = ${today} AND payment_type='CASH'
      `;
      const [{ daily_online }] = await sql`
        SELECT COALESCE(SUM(paid_amount),0) AS daily_online
        FROM sales WHERE sale_date::date = ${today} AND payment_type='ONLINE'
      `;
      const [{ daily_borrow }] = await sql`
        SELECT COALESCE(SUM(borrow_amount),0) AS daily_borrow
        FROM sales WHERE sale_date::date = ${today} AND payment_type='BORROW'
      `;
      const [{ borrower_payments }] = await sql`
        SELECT COALESCE(SUM(amount_paid),0) AS borrower_payments
        FROM borrower_payments WHERE payment_date::date = ${today}
      `;

      return res.json({
        daily_total,
        monthly_total,
        daily_cash,
        daily_online,
        daily_borrow,
        borrower_payments
      });
    }

    /* ---------------- STOCK ---------------- */
    if (route === "stock") {
      if (req.method === "GET") {
        const rows = await sql`
          SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
          FROM products p
          JOIN stock s ON s.product_id = p.id
          WHERE s.quantity > 0
        `;
        return res.json(rows);
      }

      if (req.method === "POST") {
        const { name, price, expiry_date, quantity } = req.body;

        if (!name || !price || !expiry_date || !quantity) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        // Use transaction for safety
        const result = await sql.begin(async sql => {
          // Insert or get product
          const [product] = await sql`
            INSERT INTO products (name, price, expiry_date)
            VALUES (${name}, ${price}, ${expiry_date})
            ON CONFLICT (name, price, expiry_date) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
          `;

          const pid = product.id;

          // Update stock
          const existing = await sql`
            SELECT * FROM stock WHERE product_id = ${pid}
          `;
          if (existing.length === 0) {
            await sql`INSERT INTO stock (product_id, quantity) VALUES (${pid}, ${quantity})`;
          } else {
            await sql`UPDATE stock SET quantity = quantity + ${quantity} WHERE product_id = ${pid}`;
          }
          return { success: true };
        });

        return res.json(result);
      }
    }

    /* ---------------- EXPIRED STOCK ---------------- */
    if (route === "expired") {
      const rows = await sql`
        SELECT p.name, p.price, p.expiry_date, e.quantity, e.expired_date
        FROM expired_stock e
        JOIN products p ON p.id = e.product_id
      `;
      return res.json(rows);
    }

    /* ---------------- SALE PRODUCTS ---------------- */
    if (route === "sale-products") {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await sql`
        SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
        FROM products p
        JOIN stock s ON s.product_id = p.id
        WHERE p.expiry_date >= ${today} AND s.quantity > 0
      `;
      return res.json(rows);
    }

    /* ---------------- SALES ---------------- */
    if (route === "sales") {
      if (req.method === "GET") {
        const rows = await sql`
          SELECT sale_date::date AS date, customer_name, payment_type, total_amount, paid_amount, borrow_amount
          FROM sales ORDER BY sale_date DESC
        `;
        return res.json(rows);
      }

      if (req.method === "POST") {
        const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;
        if (!items || items.length === 0) {
          return res.status(400).json({ error: "No sale items" });
        }

        const borrow_amount = payment_type === "BORROW" ? total_amount - paid_amount : 0;

        const result = await sql.begin(async sql => {
          // Insert sale
          const [sale] = await sql`
            INSERT INTO sales (sale_date, customer_name, payment_type, total_amount, paid_amount, borrow_amount)
            VALUES (NOW(), ${customer_name}, ${payment_type}, ${total_amount}, ${paid_amount}, ${borrow_amount})
            RETURNING id
          `;

          // Insert sale_items and update stock
          for (const it of items) {
            await sql`
              UPDATE stock SET quantity = quantity - ${it.quantity} WHERE product_id = ${it.product_id}
            `;
            await sql`
              INSERT INTO sale_items (sale_id, product_id, price, quantity, line_total)
              VALUES (${sale.id}, ${it.product_id}, ${it.price}, ${it.quantity}, ${it.price * it.quantity})
            `;
          }

          // Handle borrowers
          if (borrow_amount > 0 && customer_name) {
            const [b] = await sql`SELECT * FROM borrowers WHERE name = ${customer_name}`;
            if (!b) {
              await sql`
                INSERT INTO borrowers (name, outstanding_amount)
                VALUES (${customer_name}, ${borrow_amount})
              `;
            } else {
              await sql`
                UPDATE borrowers SET outstanding_amount = outstanding_amount + ${borrow_amount} WHERE id = ${b.id}
              `;
            }
          }

          return { success: true };
        });

        return res.json(result);
      }
    }

    /* ---------------- BORROWERS ---------------- */
    if (route === "borrowers") {
      const rows = await sql`
        SELECT id, name, outstanding_amount FROM borrowers WHERE outstanding_amount > 0
      `;
      return res.json(rows);
    }

    if (route === "borrower-payments") {
      const { borrower_id, amount } = req.body;
      if (!borrower_id || !amount) return res.status(400).json({ error: "Missing fields" });

      await sql.begin(async sql => {
        await sql`INSERT INTO borrower_payments (borrower_id, amount_paid) VALUES (${borrower_id}, ${amount})`;
        await sql`UPDATE borrowers SET outstanding_amount = outstanding_amount - ${amount} WHERE id = ${borrower_id}`;
      });

      return res.json({ success: true });
    }

    return res.status(404).json({ error: "Invalid route" });
  } catch (e) {
    console.error("Server error:", e);
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
});

export default app;
