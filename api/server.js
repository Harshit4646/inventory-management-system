import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { sql } from "./db.js";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

/* MOVE EXPIRED STOCK */
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

/* MAIN ROUTER */
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

    /* STOCK */
    if (route === "stock" && req.method === "GET") {
      const rows = await sql`
        SELECT p.name,p.price,p.expiry_date,s.quantity
        FROM products p
        JOIN stock s ON s.product_id=p.id
        WHERE s.quantity>0
      `;
      return res.json(rows);
    }

    if (route === "stock" && req.method === "POST") {
      const { name, price, expiry_date, quantity } = req.body;

      if (!expiry_date) {
        throw new Error("expiry_date is required");
      }

      let product = await sql`
        SELECT id FROM products
        WHERE name=${name} AND price=${price} AND expiry_date=${expiry_date}
      `;

      if (!product.length) {
        product = await sql`
          INSERT INTO products (name,price,expiry_date)
          VALUES (${name},${price},${expiry_date})
          RETURNING id
        `;
      }

      const pid = product[0].id;
      const stock = await sql`SELECT * FROM stock WHERE product_id=${pid}`;

      if (!stock.length) {
        await sql`
          INSERT INTO stock (product_id,quantity)
          VALUES (${pid},${quantity})
        `;
      } else {
        await sql`
          UPDATE stock SET quantity=quantity+${quantity}
          WHERE product_id=${pid}
        `;
      }

      return res.json({ success: true });
    }

    /* EXPIRED */
    if (route === "expired") {
      const rows = await sql`
        SELECT p.name,p.price,p.expiry_date,e.quantity,e.expired_date
        FROM expired_stock e
        JOIN products p ON p.id=e.product_id
      `;
      return res.json(rows);
    }

    /* SALE PRODUCTS */
    if (route === "sale-products") {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await sql`
        SELECT p.id,p.name,p.price,p.expiry_date,s.quantity
        FROM products p
        JOIN stock s ON s.product_id=p.id
        WHERE p.expiry_date>=${today} AND s.quantity>0
      `;
      return res.json(rows);
    }

    /* SALES LIST */
    if (route === "sales" && req.method === "GET") {
      const rows = await sql`
        SELECT id,sale_date::date AS date,customer_name,payment_type,
        total_amount,paid_amount,borrow_amount
        FROM sales ORDER BY sale_date DESC
      `;
      return res.json(rows);
    }

    /* SALES SAVE */
    if (route === "sales" && req.method === "POST") {
  const { customer_name, payment_type, items, total_amount, paid_amount } = req.body;

  let borrow_amount =
    payment_type === "BORROW" ? total_amount - paid_amount : 0;

  await sql.transaction(async tx => {
    const [sale] = await tx`
      INSERT INTO sales
      (sale_date,customer_name,payment_type,total_amount,paid_amount,borrow_amount)
      VALUES (NOW(),${customer_name},${payment_type},${total_amount},${paid_amount},${borrow_amount})
      RETURNING id
    `;

    for (const it of items) {
      const [stock] = await tx`
        SELECT quantity FROM stock WHERE product_id=${it.product_id}
      `;

      if (!stock || stock.quantity < it.quantity) {
        throw new Error("Insufficient stock");
      }

      await tx`
        UPDATE stock
        SET quantity = quantity - ${it.quantity}
        WHERE product_id = ${it.product_id}
      `;

      await tx`
        INSERT INTO sale_items
        (sale_id,product_id,price,quantity,line_total)
        VALUES
        (${sale.id},${it.product_id},${it.price},${it.quantity},${it.price * it.quantity})
      `;
    }

    if (borrow_amount > 0) {
      const b = await tx`
        SELECT id FROM borrowers WHERE name=${customer_name}
      `;

      if (!b.length) {
        await tx`
          INSERT INTO borrowers (name,outstanding_amount)
          VALUES (${customer_name},${borrow_amount})
        `;
      } else {
        await tx`
          UPDATE borrowers
          SET outstanding_amount = outstanding_amount + ${borrow_amount}
          WHERE id = ${b[0].id}
        `;
      }
    }
  });

  return res.json({ success: true });
}

    /* BORROWERS */
    if (route === "borrowers") {
      const rows = await sql`
        SELECT id,name,outstanding_amount
        FROM borrowers WHERE outstanding_amount>0
      `;
      return res.json(rows);
    }

    if (route === "borrower-payments") {
  const { borrower_id, amount } = req.body;

  await sql.transaction(async tx => {
    await tx`
      INSERT INTO borrower_payments (borrower_id,amount_paid)
      VALUES (${borrower_id},${amount})
    `;

    await tx`
      UPDATE borrowers
      SET outstanding_amount = outstanding_amount - ${amount}
      WHERE id = ${borrower_id}
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

