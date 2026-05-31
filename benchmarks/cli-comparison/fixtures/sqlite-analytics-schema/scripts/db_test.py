#!/usr/bin/env python3
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db.sqlite3"
SCHEMA_PATH = ROOT / "schema.sql"

SEED_CUSTOMERS = [
    (1, "Alice"),
    (2, "Bob"),
]
SEED_PRODUCTS = [
    (1, "Widget", 1200),
    (2, "Gadget", 2500),
]
SEED_ORDERS = [
    (1, 1, "2024-01-01T10:00:00Z"),
    (2, 2, "2024-01-01T12:00:00Z"),
    (3, 1, "2024-01-02T09:30:00Z"),
]
SEED_ITEMS = [
    (1, 1, 1, 2),  # order 1: 2 widgets => 2400
    (2, 1, 2, 1),  # order 1: 1 gadget  => 2500 (total 4900)
    (3, 2, 2, 1),  # order 2: 1 gadget  => 2500
    (4, 3, 1, 1),  # order 3: 1 widget  => 1200
]


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def reset_db(conn: sqlite3.Connection):
    conn.executescript(
        """
        PRAGMA foreign_keys=OFF;
        DROP TABLE IF EXISTS order_items;
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS products;
        DROP TABLE IF EXISTS customers;
        DROP VIEW IF EXISTS daily_sales_summary;
        PRAGMA foreign_keys=ON;
        """
    )


def apply_schema(conn: sqlite3.Connection):
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    conn.executescript(sql)


def seed(conn: sqlite3.Connection):
    conn.executemany("INSERT INTO customers(id, name) VALUES (?, ?)", SEED_CUSTOMERS)
    conn.executemany("INSERT INTO products(id, name, price_cents) VALUES (?, ?, ?)", SEED_PRODUCTS)
    conn.executemany("INSERT INTO orders(id, customer_id, order_date) VALUES (?, ?, ?)", SEED_ORDERS)
    conn.executemany(
        "INSERT INTO order_items(id, order_id, product_id, quantity) VALUES (?, ?, ?, ?)",
        SEED_ITEMS,
    )


def cmd_apply():
    conn = connect()
    try:
        reset_db(conn)
        apply_schema(conn)
        seed(conn)
        conn.commit()
    finally:
        conn.close()


def main():
    if len(sys.argv) < 2:
        print("Usage: scripts/db_test.py apply", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "apply":
        cmd_apply()
        return 0
    print(f"Unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

