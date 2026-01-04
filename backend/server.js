import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { sql } from './db.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Utility: move expired stock daily before queries
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
    await sql`DELETE FROM stock WHERE id = ${row.stock_id}`;
  }
}

// DASHBOARD
app.get('/api/dashboard', async (req, res) => {
  try {
    await moveExpiredStock();
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';

    const [{ daily_total }] = await sql`
      SELECT COALESCE(SUM(total_amount),0) AS daily_total
      FROM sales
      WHERE sale_date::date = ${today}
    `;
    const [{ monthly_total }] = await sql`
      SELECT COALESCE(SUM(total_amount),0) AS monthly_total
      FROM sales
      WHERE sale_date::date >= ${monthStart}
        AND sale_date::date <= ${today}
    `;
    const [{ daily_cash }] = await sql`
      SELECT COALESCE(SUM(paid_amount),0) AS daily_cash
      FROM sales
      WHERE sale_date::date = ${today} AND payment_type = 'CASH'
    `;
    const [{ daily_online }] = await sql`
      SELECT COALESCE(SUM(paid_amount),0) AS daily_online
      FROM sales
      WHERE sale_date::date = ${today} AND payment_type = 'ONLINE'
    `;
    const [{ daily_borrow }] = await sql`
      SELECT COALESCE(SUM(borrow_amount),0) AS daily_borrow
      FROM sales
      WHERE sale_date::date = ${today} AND payment_type = 'BORROW'
    `;
    const [{ borrower_payments }] = await sql`
      SELECT COALESCE(SUM(amount_paid),0) AS borrower_payments
      FROM borrower_payments
      WHERE payment_date::date = ${today}
    `;

    res.json({
      daily_total,
      monthly_total,
      daily_cash,
      daily_online,
      daily_borrow,
      borrower_payments
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Dashboard error' });
  }
});

// STOCK PAGE
app.get('/api/stock', async (req, res) => {
  try {
    await moveExpiredStock();
    const rows = await sql`
      SELECT p.id, p.name, p.price, p.expiry_date, COALESCE(s.quantity,0) AS quantity
      FROM products p
      JOIN stock s ON s.product_id = p.id
      WHERE s.quantity > 0
      ORDER BY p.name, p.price, p.expiry_date
    `;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stock fetch error' });
  }
});

app.post('/api/stock', async (req, res) => {
  try {
    const { name, price, expiry_date, quantity } = req.body;
    if (!name || !price || !expiry_date || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const today = new Date().toISOString().slice(0, 10);
    if (expiry_date < today) {
      return res.status(400).json({ error: 'Expiry already passed' });
    }

    const products = await sql`
      SELECT * FROM products
      WHERE name = ${name} AND price = ${price} AND expiry_date = ${expiry_date}
    `;
    let productId;
    if (products.length === 0) {
      const [p] = await sql`
        INSERT INTO products (name, price, expiry_date)
        VALUES (${name}, ${price}, ${expiry_date})
        RETURNING id
      `;
      productId = p.id;
    } else {
      productId = products[0].id;
    }

    const existingStock = await sql`
      SELECT * FROM stock WHERE product_id = ${productId}
    `;
    if (existingStock.length === 0) {
      await sql`
        INSERT INTO stock (product_id, quantity)
        VALUES (${productId}, ${quantity})
      `;
    } else {
      const newQty = existingStock[0].quantity + quantity;
      await sql`
        UPDATE stock SET quantity = ${newQty}
        WHERE product_id = ${productId}
      `;
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stock add error' });
  }
});

// EXPIRED STOCK
app.get('/api/expired', async (req, res) => {
  try {
    await moveExpiredStock();
    const rows = await sql`
      SELECT e.id, p.name, p.price, p.expiry_date, e.quantity, e.expired_date
      FROM expired_stock e
      JOIN products p ON p.id = e.product_id
      ORDER BY e.expired_date DESC
    `;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Expired fetch error' });
  }
});

// PRODUCTS FOR SALES
app.get('/api/sale-products', async (req, res) => {
  try {
    await moveExpiredStock();
    const today = new Date().toISOString().slice(0, 10);
    const rows = await sql`
      SELECT p.id, p.name, p.price, p.expiry_date, s.quantity
      FROM products p
      JOIN stock s ON s.product_id = p.id
      WHERE p.expiry_date >= ${today} AND s.quantity > 0
      ORDER BY p.name, p.price, p.expiry_date
    `;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sale products error' });
  }
});

// SALES
app.post('/api/sales', async (req, res) => {
  try {
    const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;

    if (!payment_type || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid sale data' });
    }

    let computedTotal = 0;
    for (const it of items) {
      if (!it.product_id || !it.quantity || it.quantity <= 0 || !it.price) {
        return res.status(400).json({ error: 'Invalid item' });
      }
      computedTotal += it.price * it.quantity;
    }

    if (Math.abs(computedTotal - total_amount) > 0.01) {
      return res.status(400).json({ error: 'Total mismatch' });
    }

    if (paid_amount < 0 || paid_amount > total_amount) {
      return res.status(400).json({ error: 'Invalid paid amount' });
    }

    let discount_amount = 0;
    let borrow_amount = 0;
    if (payment_type === 'BORROW') {
      borrow_amount = total_amount - paid_amount;
    } else {
      discount_amount = total_amount - paid_amount;
    }

    const today = new Date().toISOString().slice(0, 10);
    const saleDate = today;

    const result = await sql.transaction([
      sql`
        INSERT INTO sales
          (sale_date, customer_name, payment_type, total_amount, paid_amount,
           discount_amount, borrow_amount)
        VALUES (${saleDate}, ${customer_name || null}, ${payment_type},
                ${total_amount}, ${paid_amount}, ${discount_amount}, ${borrow_amount})
        RETURNING id
      `,
      sql`SELECT 1`
    ]);

    const saleId = result[0][0].id;

    for (const it of items) {
      const [stockRow] = await sql`
        SELECT s.id, s.quantity, p.expiry_date
        FROM stock s
        JOIN products p ON p.id = s.product_id
        WHERE s.product_id = ${it.product_id}
      `;
      if (!stockRow || stockRow.quantity < it.quantity) {
        throw new Error('Insufficient stock');
      }

      const newQty = stockRow.quantity - it.quantity;
      await sql`
        UPDATE stock SET quantity = ${newQty}
        WHERE id = ${stockRow.id}
      `;

      const lineTotal = it.price * it.quantity;

      await sql`
        INSERT INTO sale_items
          (sale_id, product_id, price, expiry_date, quantity, line_total)
        VALUES
          (${saleId}, ${it.product_id}, ${it.price}, ${stockRow.expiry_date},
           ${it.quantity}, ${lineTotal})
      `;
    }

    if (payment_type === 'BORROW' && borrow_amount > 0) {
      if (!customer_name) {
        throw new Error('Borrow sale requires customer name');
      }
      const borrowers = await sql`
        SELECT * FROM borrowers WHERE name = ${customer_name}
      `;
      if (borrowers.length === 0) {
        await sql`
          INSERT INTO borrowers (name, outstanding_amount)
          VALUES (${customer_name}, ${borrow_amount})
        `;
      } else {
        const newOutstanding = borrowers[0].outstanding_amount + borrow_amount;
        await sql`
          UPDATE borrowers
          SET outstanding_amount = ${newOutstanding}
          WHERE id = ${borrowers[0].id}
        `;
      }
    }

    res.json({ success: true, sale_id: saleId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sale error: ' + err.message });
  }
});

// SALES BILLS
app.get('/api/sales', async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, sale_date::date AS date, customer_name, payment_type,
             total_amount, paid_amount, borrow_amount
      FROM sales
      ORDER BY sale_date DESC
    `;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sales list error' });
  }
});

// BORROWERS
app.get('/api/borrowers', async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, name, outstanding_amount
      FROM borrowers
      WHERE outstanding_amount > 0
      ORDER BY name
    `;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Borrowers fetch error' });
  }
});

app.post('/api/borrower-payments', async (req, res) => {
  try {
    const { borrower_id, amount } = req.body;
    if (!borrower_id || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid payment data' });
    }

    const [b] = await sql`
      SELECT * FROM borrowers WHERE id = ${borrower_id}
    `;
    if (!b) return res.status(404).json({ error: 'Borrower not found' });

    if (amount > b.outstanding_amount) {
      return res.status(400).json({ error: 'Cannot pay more than outstanding' });
    }

    const discount = 0;
    const newOutstanding = b.outstanding_amount - amount;

    await sql`
      INSERT INTO borrower_payments (borrower_id, amount_paid, discount_amount)
      VALUES (${borrower_id}, ${amount}, ${discount})
    `;

    await sql`
      UPDATE borrowers SET outstanding_amount = ${newOutstanding < 0 ? 0 : newOutstanding}
      WHERE id = ${borrower_id}
    `;

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Borrower payment error' });
  }
});

// **Vercel handler**
export default app;
