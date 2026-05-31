import unittest
import sqlite3
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db.sqlite3"


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


class TestSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.check_call(["python3", "scripts/db_test.py", "apply"], cwd=str(ROOT))

    def test_tables_exist(self):
        conn = db()
        try:
            for table in ["customers", "products", "orders", "order_items"]:
                row = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    (table,),
                ).fetchone()
                self.assertIsNotNone(row, f"missing table: {table}")
        finally:
            conn.close()

    def test_foreign_keys_enforced(self):
        conn = db()
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO orders(id, customer_id, order_date) VALUES (999, 999, '2024-01-01T00:00:00Z')"
                )
        finally:
            conn.close()

    def test_indexes_exist(self):
        conn = db()
        try:
            indexes = {
                r["name"]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
                ).fetchall()
            }
            self.assertTrue(len(indexes) >= 2)
        finally:
            conn.close()

    def test_daily_sales_summary(self):
        conn = db()
        try:
            rows = conn.execute(
                "SELECT sale_date, total_orders, total_revenue, avg_order_value FROM daily_sales_summary ORDER BY sale_date"
            ).fetchall()
            self.assertGreaterEqual(len(rows), 2)
            r0 = rows[0]
            self.assertEqual(r0["sale_date"], "2024-01-01")
            self.assertEqual(r0["total_orders"], 2)
            self.assertEqual(r0["total_revenue"], 7400)
            self.assertEqual(r0["avg_order_value"], 3700)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()

