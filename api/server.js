import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { sql } from "./db.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Move expired stock daily
async function moveExpiredStock() {
  const today = new Date().toISOString().slice(0, 10);
  const expiredRows = await sql`
    SELECT s.id as stock_id, s.product_id, s.quantity, p.expiry_date
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
    await sql`DELETE FROM stock WHERE id=${row.stock_id}`;
  }
}

// Generic API route
app.all("/api/server", async (req, res) => {
  const route = req.query.route;
  try {
    await moveExpiredStock();

    // Dashboard
    if (route === "dashboard") {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + "-01";

      const [{ daily_total }] = await sql`
        SELECT COALESCE(SUM(total_amount),0) daily_total FROM sales WHERE sale_date::date=${today}
      `;
      const [{ monthly_total }] = await sql`
        SELECT COALESCE(SUM(total_amount),0) monthly_total FROM sales WHERE sale_date::date BETWEEN ${monthStart} AND ${today}
      `;
      const [{ daily_cash }] = await sql`
        SELECT COALESCE(SUM(paid_amount),0) daily_cash FROM sales WHERE sale_date::date=${today} AND payment_type='CASH'
      `;
      const [{ daily_online }] = await sql`
        SELECT COALESCE(SUM(paid_amount),0) daily_online FROM sales WHERE sale_date::date=${today} AND payment_type='ONLINE'
      `;
      const [{ daily_borrow }] = await sql`
        SELECT COALESCE(SUM(borrow_amount),0) daily_borrow FROM sales WHERE sale_date::date=${today} AND payment_type='BORROW'
      `;
      const [{ borrower_payments }] = await sql`
        SELECT COALESCE(SUM(amount_paid),0) borrower_payments FROM borrower_payments WHERE payment_date::date=${today}
      `;

      return res.json({ daily_total, monthly_total, daily_cash, daily_online, daily_borrow, borrower_payments });
    }

    // Stock GET
    if (route === "stock" && req.method === "GET") {
      const rows = await sql`
        SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
        FROM products p JOIN stock s ON s.product_id=p.id
        WHERE s.quantity>0 ORDER BY p.name, p.expiry_date
      `;
      return res.json(rows);
    }

    // Stock POST
    if (route === "stock" && req.method === "POST") {
      const { name, price, expiry_date, quantity } = req.body;

      if (!name || !price || !expiry_date || !quantity || quantity <= 0)
        return res.status(400).json({ error: "Invalid input" });

      const today = new Date().toISOString().slice(0, 10);
      if (expiry_date < today)
        return res.status(400).json({ error: "Expiry already passed" });

      // Insert product if not exists
      const [product] = await sql`
        INSERT INTO products (name, price, expiry_date)
        VALUES (${name}, ${price}, ${expiry_date})
        ON CONFLICT (name, price, expiry_date) DO UPDATE SET name=EXCLUDED.name
        RETURNING id
      `;
      const pid = product.id;

      // Insert or update stock
      await sql`
        INSERT INTO stock (product_id, quantity)
        VALUES (${pid}, ${quantity})
        ON CONFLICT (product_id) DO UPDATE SET quantity=stock.quantity + EXCLUDED.quantity
      `;
      return res.json({ success: true });
    }

    // Expired
    if (route === "expired") {
      const rows = await sql`
        SELECT e.id, p.name, p.price, p.expiry_date, e.quantity, e.expired_date
        FROM expired_stock e JOIN products p ON p.id=e.product_id
        ORDER BY e.expired_date DESC
      `;
      return res.json(rows);
    }

    // Sale products
    if (route === "sale-products") {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await sql`
        SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
        FROM products p JOIN stock s ON s.product_id=p.id
        WHERE p.expiry_date >= ${today} AND s.quantity > 0
        ORDER BY p.name, p.price, p.expiry_date
      `;
      return res.json(rows);
    }

    // Sales GET
    if (route === "sales" && req.method === "GET") {
      const rows = await sql`
        SELECT id, sale_date::date AS date, customer_name, payment_type,
               total_amount, paid_amount, borrow_amount
        FROM sales ORDER BY sale_date DESC
      `;
      return res.json(rows);
    }

    // Sales POST
    if (route === "sales" && req.method === "POST") {
      const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;
      if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ error: "No items provided" });

      let borrow_amount = payment_type === "BORROW" ? total_amount - paid_amount : 0;

      const [sale] = await sql.transaction(async (tx) => {
        const [s] = await tx`
          INSERT INTO sales (sale_date, customer_name, payment_type, total_amount, paid_amount, borrow_amount)
          VALUES (NOW(), ${customer_name}, ${payment_type}, ${total_amount}, ${paid_amount}, ${borrow_amount})
          RETURNING id
        `;

        for (const it of items) {
          const [stockRow] = await tx`
            SELECT s.id, s.quantity, p.expiry_date
            FROM stock s JOIN products p ON p.id = s.product_id
            WHERE s.product_id=${it.product_id}
          `;
          if (!stockRow || stockRow.quantity < it.quantity) {
            throw new Error(`Insufficient stock for product ID ${it.product_id}`);
          }
          await tx`UPDATE stock SET quantity=${stockRow.quantity - it.quantity} WHERE id=${stockRow.id}`;
          await tx`
            INSERT INTO sale_items (sale_id, product_id, price, quantity, line_total, expiry_date)
            VALUES (${s.id}, ${it.product_id}, ${it.price}, ${it.quantity}, ${it.price * it.quantity}, ${stockRow.expiry_date})
          `;
        }

        if (borrow_amount > 0) {
          const [b] = await tx`SELECT * FROM borrowers WHERE name=${customer_name}`;
          if (!b) {
            await tx`INSERT INTO borrowers (name, outstanding_amount) VALUES (${customer_name}, ${borrow_amount})`;
          } else {
            await tx`UPDATE borrowers SET outstanding_amount=outstanding_amount+${borrow_amount} WHERE id=${b.id}`;
          }
        }

        return s;
      });

      return res.json({ success: true, sale_id: sale.id });
    }

    // Borrowers
    if (route === "borrowers") {
      const rows = await sql`SELECT id,name,outstanding_amount FROM borrowers WHERE outstanding_amount>0 ORDER BY name`;
      return res.json(rows);
    }

    if (route === "borrower-payments") {
      const { borrower_id, amount } = req.body;
      if (!borrower_id || !amount) return res.status(400).json({ error: "Invalid data" });

      await sql.transaction(async (tx) => {
        await tx`
          INSERT INTO borrower_payments (borrower_id, amount_paid)
          VALUES (${borrower_id}, ${amount})
        `;
        await tx`
          UPDATE borrowers SET outstanding_amount=outstanding_amount-${amount} WHERE id=${borrower_id}
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
