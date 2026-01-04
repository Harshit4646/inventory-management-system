import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { sql } from "./db.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// --- Move expired stock ---
async function moveExpiredStock() {
  const today = new Date().toISOString().slice(0, 10);
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

// --- API handler ---
app.all("/api/server", async (req, res) => {
  const route = req.query.route;

  try {
    await moveExpiredStock();

    /* DASHBOARD */
    if (route === "dashboard") {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + "-01";

      const [{ daily_total }] = await sql`
        SELECT COALESCE(SUM(total_amount),0) daily_total
        FROM sales WHERE sale_date::date=${today}
      `;
      const [{ monthly_total }] = await sql`
        SELECT COALESCE(SUM(total_amount),0) monthly_total
        FROM sales
        WHERE sale_date::date BETWEEN ${monthStart} AND ${today}
      `;
      const [{ daily_cash }] = await sql`
        SELECT COALESCE(SUM(paid_amount),0) daily_cash
        FROM sales WHERE sale_date::date=${today} AND payment_type='CASH'
      `;
      const [{ daily_online }] = await sql`
        SELECT COALESCE(SUM(paid_amount),0) daily_online
        FROM sales WHERE sale_date::date=${today} AND payment_type='ONLINE'
      `;
      const [{ daily_borrow }] = await sql`
        SELECT COALESCE(SUM(borrow_amount),0) daily_borrow
        FROM sales WHERE sale_date::date=${today} AND payment_type='BORROW'
      `;
      const [{ borrower_payments }] = await sql`
        SELECT COALESCE(SUM(amount_paid),0) borrower_payments
        FROM borrower_payments WHERE payment_date::date=${today}
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

    /* STOCK GET */
    if (route === "stock" && req.method === "GET") {
      const rows = await sql`
        SELECT p.name, p.price, p.expiry_date, s.quantity
        FROM products p
        JOIN stock s ON s.product_id=p.id
        WHERE s.quantity>0
        ORDER BY p.name, p.price, p.expiry_date
      `;
      return res.json(rows);
    }

    /* STOCK POST */
    if (route === "stock" && req.method === "POST") {
      const { name, price, expiry_date, quantity } = req.body;

      if (!name || !price || !expiry_date || !quantity || quantity <= 0) {
        return res.status(400).json({ error: "Invalid input" });
      }

      const today = new Date().toISOString().slice(0, 10);
      if (expiry_date < today) {
        return res.status(400).json({ error: "Expiry already passed" });
      }

      // Insert product with ON CONFLICT on unique (name, price, expiry_date)
      const [product] = await sql`
        INSERT INTO products (name, price, expiry_date)
        VALUES (${name}, ${price}, ${expiry_date})
        ON CONFLICT (name, price, expiry_date) DO NOTHING
        RETURNING id
      `;

      // If product already exists, fetch its id
      let pid;
      if (product) pid = product.id;
      else {
        const [existing] = await sql`
          SELECT id FROM products WHERE name=${name} AND price=${price} AND expiry_date=${expiry_date}
        `;
        pid = existing.id;
      }

      // Insert/update stock
      await sql`
        INSERT INTO stock (product_id, quantity)
        VALUES (${pid}, ${quantity})
        ON CONFLICT (product_id)
        DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity
      `;

      return res.json({ success: true });
    }

    /* EXPIRED STOCK */
    if (route === "expired") {
      const rows = await sql`
        SELECT p.name, p.price, p.expiry_date, e.quantity, e.expired_date
        FROM expired_stock e
        JOIN products p ON p.id=e.product_id
        ORDER BY e.expired_date DESC
      `;
      return res.json(rows);
    }

    /* SALE PRODUCTS */
    if (route === "sale-products") {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await sql`
        SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
        FROM products p
        JOIN stock s ON s.product_id=p.id
        WHERE p.expiry_date >= ${today} AND s.quantity>0
        ORDER BY p.name, p.price, p.expiry_date
      `;
      return res.json(rows);
    }

    /* SALES GET */
    if (route === "sales" && req.method === "GET") {
      const rows = await sql`
        SELECT id, sale_date::date AS date, customer_name, payment_type,
               total_amount, paid_amount, borrow_amount
        FROM sales
        ORDER BY sale_date DESC
      `;
      return res.json(rows);
    }

    /* SALES POST */
    if (route === "sales" && req.method === "POST") {
      const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "No items in sale" });
      }

      const borrow_amount = payment_type === "BORROW" ? total_amount - paid_amount : 0;

      // Transaction: insert sale and sale_items, update stock
      const [sale] = await sql.transaction(async sql => {
        const [s] = await sql`
          INSERT INTO sales (sale_date, customer_name, payment_type, total_amount, paid_amount, borrow_amount)
          VALUES (NOW(), ${customer_name}, ${payment_type}, ${total_amount}, ${paid_amount}, ${borrow_amount})
          RETURNING id
        `;

        for (const it of items) {
          // Fetch stock row
          const [stockRow] = await sql`
            SELECT s.quantity, p.expiry_date
            FROM stock s JOIN products p ON p.id = s.product_id
            WHERE s.product_id=${it.product_id}
          `;
          if (!stockRow || stockRow.quantity < it.quantity) {
            throw new Error(`Insufficient stock for product id ${it.product_id}`);
          }

          // Update stock
          await sql`
            UPDATE stock SET quantity = quantity - ${it.quantity} WHERE product_id=${it.product_id}
          `;

          // Insert sale item with expiry_date
          await sql`
            INSERT INTO sale_items (sale_id, product_id, price, quantity, line_total, expiry_date)
            VALUES (${s.id}, ${it.product_id}, ${it.price}, ${it.quantity}, ${it.price * it.quantity}, ${stockRow.expiry_date})
          `;
        }

        return [s];
      });

      // Handle borrow
      if (borrow_amount > 0) {
        const [b] = await sql`SELECT * FROM borrowers WHERE name=${customer_name}`;
        if (!b) {
          await sql`INSERT INTO borrowers (name, outstanding_amount) VALUES (${customer_name}, ${borrow_amount})`;
        } else {
          await sql`UPDATE borrowers SET outstanding_amount = outstanding_amount + ${borrow_amount} WHERE id=${b.id}`;
        }
      }

      return res.json({ success: true });
    }

    /* BORROWERS GET */
    if (route === "borrowers") {
      const rows = await sql`
        SELECT id, name, outstanding_amount
        FROM borrowers
        WHERE outstanding_amount > 0
        ORDER BY name
      `;
      return res.json(rows);
    }

    /* BORROWER PAYMENTS */
    if (route === "borrower-payments" && req.method === "POST") {
      const { borrower_id, amount } = req.body;
      if (!borrower_id || !amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid payment" });
      }

      const [b] = await sql`SELECT * FROM borrowers WHERE id=${borrower_id}`;
      if (!b) return res.status(404).json({ error: "Borrower not found" });

      const newOutstanding = Math.max(0, b.outstanding_amount - amount);

      await sql.transaction(async sql => {
        await sql`
          INSERT INTO borrower_payments (borrower_id, amount_paid)
          VALUES (${borrower_id}, ${amount})
        `;
        await sql`
          UPDATE borrowers SET outstanding_amount = ${newOutstanding} WHERE id=${borrower_id}
        `;
      });

      return res.json({ success: true });
    }

    return res.status(404).json({ error: "Invalid route" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

export default app;
