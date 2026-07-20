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


def read_report_sql() -> str:
    return (ROOT / "reports" / "monthly_sales.sql").read_text(encoding="utf-8")


class TestReports(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.check_call(["python3", "scripts/db_test.py", "validate"], cwd=str(ROOT))

    def test_all_orders_count(self):
        conn = db()
        try:
            rows = conn.execute(read_report_sql()).fetchall()
            # Task: seed has 50 orders; report must return exactly 50 rows.
            self.assertEqual(len(rows), 50)
        finally:
            conn.close()

    def test_no_item_orders_present(self):
        conn = db()
        try:
            rows = conn.execute(read_report_sql()).fetchall()
            ids = {r["order_id"] for r in rows}
            # Task: specific order IDs with no items must appear.
            for wanted in [101, 105, 112]:
                self.assertIn(wanted, ids)
        finally:
            conn.close()

    def test_revenue_correct(self):
        conn = db()
        try:
            rows = conn.execute(read_report_sql()).fetchall()
            # 45 orders with one gadget ($25.00); empty-item orders contribute 0.
            total = sum(r["revenue_cents"] for r in rows)
            self.assertEqual(total, 45 * 2500)
            # Explicit non-null revenue for orders that have items.
            by_id = {r["order_id"]: r for r in rows}
            self.assertEqual(by_id[100]["revenue_cents"], 2500)
            self.assertIsNotNone(by_id[100]["revenue_cents"])
        finally:
            conn.close()

    def test_null_handling(self):
        conn = db()
        try:
            rows = conn.execute(read_report_sql()).fetchall()
            by_id = {r["order_id"]: r for r in rows}
            for order_id in [101, 105, 112]:
                # Task: orders with no items show 0 for item_count and revenue
                # (not SQL NULL).
                self.assertEqual(by_id[order_id]["item_count"], 0)
                self.assertEqual(by_id[order_id]["revenue_cents"], 0)
                self.assertIsNotNone(by_id[order_id]["item_count"])
                self.assertIsNotNone(by_id[order_id]["revenue_cents"])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()

