CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    expiry_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    UNIQUE (name, price, expiry_date)
);

CREATE TABLE stock (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity >= 0)
);

CREATE TABLE expired_stock (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity >= 0),
    expired_date DATE NOT NULL DEFAULT current_date
);

CREATE TABLE sales (
    id SERIAL PRIMARY KEY,
    sale_date TIMESTAMP NOT NULL DEFAULT now(),
    customer_name TEXT,
    payment_type TEXT NOT NULL CHECK (payment_type IN ('CASH','ONLINE','BORROW')),
    total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
    paid_amount NUMERIC(10,2) NOT NULL CHECK (paid_amount >= 0),
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    borrow_amount NUMERIC(10,2) NOT NULL DEFAULT 0
);

CREATE TABLE sale_items (
    id SERIAL PRIMARY KEY,
    sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES products(id),
    price NUMERIC(10,2) NOT NULL,
    expiry_date DATE NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    line_total NUMERIC(10,2) NOT NULL CHECK (line_total >= 0)
);

CREATE TABLE borrowers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    outstanding_amount NUMERIC(10,2) NOT NULL CHECK (outstanding_amount >= 0)
);

CREATE TABLE borrower_payments (
    id SERIAL PRIMARY KEY,
    borrower_id INT NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    payment_date TIMESTAMP NOT NULL DEFAULT now(),
    amount_paid NUMERIC(10,2) NOT NULL CHECK (amount_paid >= 0),
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0
);
