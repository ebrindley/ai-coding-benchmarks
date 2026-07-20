import unittest
import sqlite3
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db.sqlite3"
SCHEMA_PATH = ROOT / "schema.sql"

# Columns required by the task description / seed harness contract.
REQUIRED_COLUMNS = {
    "customers": {"id", "name"},
    "products": {"id", "name", "price_cents"},
    "orders": {"id", "customer_id", "order_date"},
    "order_items": {"id", "order_id", "product_id", "quantity"},
}

# Exact index targets from the task description.
REQUIRED_INDEX_TARGETS = {
    ("orders", "order_date"),
    ("orders", "customer_id"),
    ("order_items", "product_id"),
}


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def table_columns(conn, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def indexed_columns(conn) -> set[tuple[str, str]]:
    """Return {(table, column)} covered by non-auto indexes."""
    found: set[tuple[str, str]] = set()
    for idx in conn.execute(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
    ).fetchall():
        name = idx["name"]
        table = idx["tbl_name"]
        for col in conn.execute(f"PRAGMA index_info({name})").fetchall():
            found.add((table, col["name"]))
    return found


class TestSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.check_call(["python3", "scripts/db_test.py", "apply"], cwd=str(ROOT))

    def test_tables_exist(self):
        conn = db()
        try:
            for table in REQUIRED_COLUMNS:
                row = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    (table,),
                ).fetchone()
                self.assertIsNotNone(row, f"missing table: {table}")
        finally:
            conn.close()

    def test_required_columns(self):
        conn = db()
        try:
            for table, cols in REQUIRED_COLUMNS.items():
                present = table_columns(conn, table)
                missing = cols - present
                self.assertFalse(
                    missing, f"{table} missing required columns: {sorted(missing)}"
                )
        finally:
            conn.close()

    def test_primary_keys(self):
        conn = db()
        try:
            for table in REQUIRED_COLUMNS:
                pk_cols = [
                    r["name"]
                    for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
                    if r["pk"]
                ]
                self.assertTrue(pk_cols, f"{table} must have a primary key")
                self.assertIn("id", pk_cols, f"{table} primary key should include id")
        finally:
            conn.close()

    def test_foreign_keys_enforced(self):
        conn = db()
        try:
            # orders.customer_id -> customers
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO orders(id, customer_id, order_date) "
                    "VALUES (999, 999, '2024-01-01T00:00:00Z')"
                )
            # order_items.order_id -> orders
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO order_items(id, order_id, product_id, quantity) "
                    "VALUES (999, 999, 1, 1)"
                )
            # order_items.product_id -> products
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO order_items(id, order_id, product_id, quantity) "
                    "VALUES (998, 1, 999, 1)"
                )
        finally:
            conn.close()

    def test_indexes_exist(self):
        conn = db()
        try:
            found = indexed_columns(conn)
            missing = REQUIRED_INDEX_TARGETS - found
            self.assertFalse(
                missing,
                f"missing required index targets (table, column): {sorted(missing)}",
            )
        finally:
            conn.close()

    def test_daily_sales_summary(self):
        conn = db()
        try:
            # View must expose exactly the contracted columns.
            cols = {
                r["name"]
                for r in conn.execute("PRAGMA table_info(daily_sales_summary)").fetchall()
            }
            required = {"sale_date", "total_orders", "total_revenue", "avg_order_value"}
            self.assertTrue(
                required.issubset(cols),
                f"daily_sales_summary missing columns: {sorted(required - cols)}",
            )

            rows = conn.execute(
                "SELECT sale_date, total_orders, total_revenue, avg_order_value "
                "FROM daily_sales_summary ORDER BY sale_date"
            ).fetchall()
            self.assertGreaterEqual(len(rows), 2)
            r0 = rows[0]
            self.assertEqual(r0["sale_date"], "2024-01-01")
            self.assertEqual(r0["total_orders"], 2)
            self.assertEqual(r0["total_revenue"], 7400)
            self.assertEqual(r0["avg_order_value"], 3700)
        finally:
            conn.close()

    def test_schema_idempotent(self):
        """Reapplying schema.sql must preserve existing data."""
        sql = SCHEMA_PATH.read_text(encoding="utf-8")
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON;")
        try:
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO customers(id, name) VALUES (9001, 'Sentinel Customer')"
            )
            conn.execute(
                "INSERT INTO products(id, name, price_cents) "
                "VALUES (9001, 'Sentinel Product', 1234)"
            )
            conn.execute(
                "INSERT INTO orders(id, customer_id, order_date) "
                "VALUES (9001, 9001, '2030-01-01T00:00:00Z')"
            )
            conn.execute(
                "INSERT INTO order_items(id, order_id, product_id, quantity) "
                "VALUES (9001, 9001, 9001, 2)"
            )
            conn.commit()

            conn.executescript(sql)
            for table in REQUIRED_COLUMNS:
                row = conn.execute(
                    f"SELECT id FROM {table} WHERE id = 9001"
                ).fetchone()
                self.assertIsNotNone(
                    row, f"reapplying schema.sql destroyed existing {table} data"
                )
            tables = {
                r["name"]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            for table in REQUIRED_COLUMNS:
                self.assertIn(table, tables)
            view = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='view' AND name='daily_sales_summary'"
            ).fetchone()
            self.assertIsNotNone(view, "daily_sales_summary view missing after re-apply")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
