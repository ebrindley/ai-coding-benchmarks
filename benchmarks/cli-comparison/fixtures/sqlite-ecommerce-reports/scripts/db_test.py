#!/usr/bin/env python3
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db.sqlite3"
SCHEMA_PATH = ROOT / "schema.sql"
REPORT_PATH = ROOT / "reports" / "monthly_sales.sql"


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
        PRAGMA foreign_keys=ON;
        """
    )


def apply_schema(conn: sqlite3.Connection):
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    conn.executescript(sql)


def seed(conn: sqlite3.Connection):
    conn.executemany(
        "INSERT INTO products(id, name, price_cents) VALUES (?, ?, ?)",
        [(1, "Widget", 1200), (2, "Gadget", 2500)],
    )

    orders = [(100 + i, "2024-01-01T00:00:00Z") for i in range(50)]
    conn.executemany("INSERT INTO orders(id, order_date) VALUES (?, ?)", orders)

    no_item_ids = {101, 105, 112, 130, 145}
    item_id = 1
    items = []
    for order_id, _ in orders:
        if order_id in no_item_ids:
            continue
        items.append((item_id, order_id, 2, 1))  # 1 gadget each
        item_id += 1
    conn.executemany(
        "INSERT INTO order_items(id, order_id, product_id, quantity) VALUES (?, ?, ?, ?)",
        items,
    )


def ensure_db():
    conn = connect()
    try:
        reset_db(conn)
        apply_schema(conn)
        seed(conn)
        conn.commit()
    finally:
        conn.close()


def validate_report():
    ensure_db()
    sql = REPORT_PATH.read_text(encoding="utf-8")
    conn = connect()
    try:
        rows = conn.execute(sql).fetchall()
        if len(rows) == 0:
            raise RuntimeError("report returned 0 rows")
    finally:
        conn.close()


def main():
    if len(sys.argv) < 2:
        print("Usage: scripts/db_test.py validate", file=sys.stderr)
        return 2
    if sys.argv[1] == "validate":
        validate_report()
        return 0
    print(f"Unknown command: {sys.argv[1]}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

