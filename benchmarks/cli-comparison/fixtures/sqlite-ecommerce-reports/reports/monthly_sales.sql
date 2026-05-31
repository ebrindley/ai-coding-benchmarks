-- Monthly sales report (BUGGY)
-- Returns one row per order with item_count and revenue_cents.
--
-- BUG: INNER JOIN excludes orders with no items; should include all orders.

SELECT
  o.id AS order_id,
  DATE(o.order_date) AS sale_date,
  COUNT(oi.id) AS item_count,
  COALESCE(SUM(oi.quantity * p.price_cents), 0) AS revenue_cents
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
GROUP BY o.id, DATE(o.order_date)
ORDER BY o.id;
