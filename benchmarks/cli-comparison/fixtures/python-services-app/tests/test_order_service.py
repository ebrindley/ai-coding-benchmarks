"""Tests for OrderService - 10 tests."""

import pytest

from src.services.order_service import OrderService, OrderStatus, ValidationError


class TestOrderServiceValidation:
    """Tests for validation methods."""

    def test_validate_email_valid(self):
        """Valid email is accepted and normalized."""
        service = OrderService()
        result = service.validate_email("  Customer@Shop.COM  ")
        assert result == "customer@shop.com"

    def test_validate_email_too_long_raises(self):
        """Email exceeding 254 chars raises ValidationError."""
        service = OrderService()
        long_email = "a" * 250 + "@b.com"
        with pytest.raises(ValidationError, match="Email too long"):
            service.validate_email(long_email)

    def test_validate_address_valid(self):
        """Valid address is accepted and normalized."""
        service = OrderService()
        result = service.validate_address("456  Oak  Avenue  Suite 100")
        assert result == "456 Oak Avenue Suite 100"

    def test_validate_address_too_short_raises(self):
        """Short address raises ValidationError."""
        service = OrderService()
        with pytest.raises(ValidationError, match="Address too short"):
            service.validate_address("1 A St")


class TestOrderServiceCRUD:
    """Tests for CRUD operations."""

    def test_create_order_valid(self):
        """Create order with valid data."""
        service = OrderService()
        order = service.create_order(
            customer_email="customer@example.com",
            shipping_address="789 Pine Road Building A",
            items=[{"product_id": 1, "quantity": 2, "price": 29.99}],
        )
        assert order.id == 1
        assert order.customer_email == "customer@example.com"
        assert order.status == OrderStatus.PENDING
        assert len(order.items) == 1

    def test_create_order_no_items_raises(self):
        """Order without items raises ValidationError."""
        service = OrderService()
        with pytest.raises(ValidationError, match="at least one item"):
            service.create_order(
                customer_email="customer@example.com",
                shipping_address="789 Pine Road Building A",
                items=[],
            )

    def test_create_order_invalid_quantity_raises(self):
        """Order with zero quantity raises ValidationError."""
        service = OrderService()
        with pytest.raises(ValidationError, match="quantity must be positive"):
            service.create_order(
                customer_email="customer@example.com",
                shipping_address="789 Pine Road Building A",
                items=[{"product_id": 1, "quantity": 0, "price": 29.99}],
            )

    def test_get_order_total(self):
        """Order total is calculated correctly."""
        service = OrderService()
        order = service.create_order(
            customer_email="customer@example.com",
            shipping_address="789 Pine Road Building A",
            items=[
                {"product_id": 1, "quantity": 2, "price": 10.00},
                {"product_id": 2, "quantity": 1, "price": 25.00},
            ],
        )
        total = service.get_order_total(order.id)
        assert total == 45.00

    def test_confirm_order(self):
        """Pending order can be confirmed."""
        service = OrderService()
        order = service.create_order(
            customer_email="customer@example.com",
            shipping_address="789 Pine Road Building A",
            items=[{"product_id": 1, "quantity": 1, "price": 10.00}],
        )
        confirmed = service.confirm_order(order.id)
        assert confirmed.status == OrderStatus.CONFIRMED

    def test_cancel_shipped_order_raises(self):
        """Shipped order cannot be cancelled."""
        service = OrderService()
        order = service.create_order(
            customer_email="customer@example.com",
            shipping_address="789 Pine Road Building A",
            items=[{"product_id": 1, "quantity": 1, "price": 10.00}],
        )
        service.confirm_order(order.id)
        service.ship_order(order.id)
        with pytest.raises(ValidationError, match="Cannot cancel shipped"):
            service.cancel_order(order.id)
