// api/server.js
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

let lastExpiredCheck = null;

// Move expired stock
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

// Main handler for Vercel serverless
export default async function handler(req, res) {
  const route = req.query.route;

  try {
    await moveExpiredStock();

    const today = new Date().toISOString().slice(0, 10);

    /* ---------------- DASHBOARD ---------------- */
    if (route === "dashboard") {
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

      return res.status(200).json({
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
        const rows = await sql`
          SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
          FROM products p
          JOIN stock s ON s.product_id = p.id
          WHERE s.quantity > 0
          ORDER BY p.name
        `;
        return res.status(200).json(rows);
      }

      if (req.method === "POST") {
        const { name, price, expiry_date, quantity } = req.body;
        if (!name || !price || !expiry_date || !quantity)
          return res.status(400).json({ error: "Missing fields" });

        await sql.begin(async sql => {
          const [product] = await sql`
            INSERT INTO products (name, price, expiry_date)
            VALUES (${name}, ${price}, ${expiry_date})
            ON CONFLICT (name, price, expiry_date) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
          `;
          const pid = product.id;

          const existing = await sql`SELECT * FROM stock WHERE product_id = ${pid}`;
          if (existing.length === 0) {
            await sql`INSERT INTO stock (product_id, quantity) VALUES (${pid}, ${quantity})`;
          } else {
            await sql`UPDATE stock SET quantity = quantity + ${quantity} WHERE product_id = ${pid}`;
          }
        });

        return res.status(200).json({ success: true });
      }
    }

    /* ---------------- EXPIRED ---------------- */
    if (route === "expired") {
      const rows = await sql`
        SELECT p.name, p.price, p.expiry_date, e.quantity, e.expired_date
        FROM expired_stock e
        JOIN products p ON p.id = e.product_id
        ORDER BY e.expired_date DESC
      `;
      return res.status(200).json(rows);
    }

    /* ---------------- SALE PRODUCTS ---------------- */
    if (route === "sale-products") {
      const rows = await sql`
        SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
        FROM products p
        JOIN stock s ON s.product_id = p.id
        WHERE p.expiry_date >= ${today} AND s.quantity > 0
        ORDER BY p.name
      `;
      return res.status(200).json(rows);
    }

    /* ---------------- SALES ---------------- */
    if (route === "sales") {
      if (req.method === "GET") {
        const rows = await sql`
          SELECT sale_date::date AS date, customer_name, payment_type, total_amount, paid_amount, borrow_amount
          FROM sales ORDER BY sale_date DESC
        `;
        return res.status(200).json(rows);
      }

      if (req.method === "POST") {
        const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;
        if (!items || items.length === 0)
          return res.status(400).json({ error: "No sale items" });

        const borrow_amount = payment_type === "BORROW" ? total_amount - paid_amount : 0;

        await sql.begin(async sql => {
          const [sale] = await sql`
            INSERT INTO sales (sale_date, customer_name, payment_type, total_amount, paid_amount, borrow_amount)
            VALUES (NOW(), ${customer_name}, ${payment_type}, ${total_amount}, ${paid_amount}, ${borrow_amount})
            RETURNING id
          `;

          for (const it of items) {
            await sql`UPDATE stock SET quantity = quantity - ${it.quantity} WHERE product_id = ${it.product_id}`;
            await sql`
              INSERT INTO sale_items (sale_id, product_id, price, quantity, line_total)
              VALUES (${sale.id}, ${it.product_id}, ${it.price}, ${it.quantity}, ${it.price * it.quantity})
            `;
          }

          if (borrow_amount > 0 && customer_name) {
            const [b] = await sql`SELECT * FROM borrowers WHERE name = ${customer_name}`;
            if (!b) {
              await sql`INSERT INTO borrowers (name, outstanding_amount) VALUES (${customer_name}, ${borrow_amount})`;
            } else {
              await sql`UPDATE borrowers SET outstanding_amount = outstanding_amount + ${borrow_amount} WHERE id = ${b.id}`;
            }
          }
        });

        return res.status(200).json({ success: true });
      }
    }

    /* ---------------- BORROWERS ---------------- */
    if (route === "borrowers") {
      const rows = await sql`
        SELECT id, name, outstanding_amount
        FROM borrowers
        WHERE outstanding_amount > 0
        ORDER BY name
      `;
      return res.status(200).json(rows);
    }

    if (route === "borrower-payments" && req.method === "POST") {
      const { borrower_id, amount } = req.body;
      if (!borrower_id || !amount)
        return res.status(400).json({ error: "Missing fields" });

      await sql.begin(async sql => {
        await sql`INSERT INTO borrower_payments (borrower_id, amount_paid) VALUES (${borrower_id}, ${amount})`;
        await sql`UPDATE borrowers SET outstanding_amount = outstanding_amount - ${amount} WHERE id = ${borrower_id}`;
      });

      return res.status(200).json({ success: true });
    }

    return res.status(404).json({ error: "Invalid route" });
  } catch (err) {
    console.error("Server error:", err); // Full stack in Vercel logs
    return res.status(500).json({
      error: "Server error occurred",
      message: err.message,
      stack: err.stack,
    });
  }
}
