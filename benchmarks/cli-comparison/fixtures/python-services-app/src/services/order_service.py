"""Order service with order management operations."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional


class OrderStatus(Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    SHIPPED = "shipped"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


@dataclass
class OrderItem:
    product_id: int
    quantity: int
    price: float


@dataclass
class Order:
    id: int
    customer_email: str
    shipping_address: str
    items: List[OrderItem] = field(default_factory=list)
    status: OrderStatus = OrderStatus.PENDING
    created_at: datetime = field(default_factory=datetime.now)


class ValidationError(Exception):
    """Raised when validation fails."""

    pass


class OrderService:
    """Service for order management operations."""

    def __init__(self, inventory_service=None):
        self._inventory = inventory_service
        self._orders: Dict[int, Order] = {}
        self._next_id = 1

    # -------------------------------------------------------------------------
    # DUPLICATE VALIDATION LOGIC (appears in user_service.py, admin_service.py)
    # -------------------------------------------------------------------------

    def validate_email(self, email: str) -> str:
        """Validate and normalize email address.

        Args:
            email: Email address to validate

        Returns:
            Normalized email (lowercase, stripped)

        Raises:
            ValidationError: If email is invalid
        """
        if not email:
            raise ValidationError("Email is required")

        email = email.strip().lower()

        # Basic email pattern
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        if not re.match(pattern, email):
            raise ValidationError("Invalid email format")

        if len(email) > 254:
            raise ValidationError("Email too long")

        return email

    def validate_address(self, address: str) -> str:
        """Validate and normalize address.

        Args:
            address: Address to validate

        Returns:
            Normalized address (trimmed, single spaces)

        Raises:
            ValidationError: If address is invalid
        """
        if not address:
            raise ValidationError("Address is required")

        # Normalize whitespace
        address = " ".join(address.split())

        if len(address) < 10:
            raise ValidationError("Address too short")

        if len(address) > 500:
            raise ValidationError("Address too long")

        # Must contain at least one digit (street number)
        if not re.search(r"\d", address):
            raise ValidationError("Address must contain a street number")

        return address

    # -------------------------------------------------------------------------
    # SERVICE METHODS
    # -------------------------------------------------------------------------

    def create_order(
        self, customer_email: str, shipping_address: str, items: List[dict]
    ) -> Order:
        """Create a new order.

        Args:
            customer_email: Customer's email address
            shipping_address: Shipping address
            items: List of items [{product_id, quantity, price}]

        Returns:
            Created order object
        """
        validated_email = self.validate_email(customer_email)
        validated_address = self.validate_address(shipping_address)

        if not items:
            raise ValidationError("Order must have at least one item")

        order_items = []
        for item in items:
            if item.get("quantity", 0) <= 0:
                raise ValidationError("Item quantity must be positive")
            if item.get("price", 0) <= 0:
                raise ValidationError("Item price must be positive")

            order_items.append(
                OrderItem(
                    product_id=item["product_id"],
                    quantity=item["quantity"],
                    price=item["price"],
                )
            )

        order = Order(
            id=self._next_id,
            customer_email=validated_email,
            shipping_address=validated_address,
            items=order_items,
        )
        self._orders[order.id] = order
        self._next_id += 1

        return order

    def get_order(self, order_id: int) -> Optional[Order]:
        """Get order by ID."""
        return self._orders.get(order_id)

    def update_shipping_address(self, order_id: int, address: str) -> Order:
        """Update order's shipping address."""
        order = self._orders.get(order_id)
        if not order:
            raise ValidationError("Order not found")

        if order.status != OrderStatus.PENDING:
            raise ValidationError("Cannot update shipped order")

        validated_address = self.validate_address(address)
        order.shipping_address = validated_address
        return order

    def confirm_order(self, order_id: int) -> Order:
        """Confirm a pending order."""
        order = self._orders.get(order_id)
        if not order:
            raise ValidationError("Order not found")

        if order.status != OrderStatus.PENDING:
            raise ValidationError("Order is not pending")

        order.status = OrderStatus.CONFIRMED
        return order

    def ship_order(self, order_id: int) -> Order:
        """Mark order as shipped."""
        order = self._orders.get(order_id)
        if not order:
            raise ValidationError("Order not found")

        if order.status != OrderStatus.CONFIRMED:
            raise ValidationError("Order is not confirmed")

        order.status = OrderStatus.SHIPPED
        return order

    def cancel_order(self, order_id: int) -> Order:
        """Cancel an order."""
        order = self._orders.get(order_id)
        if not order:
            raise ValidationError("Order not found")

        if order.status in (OrderStatus.SHIPPED, OrderStatus.DELIVERED):
            raise ValidationError("Cannot cancel shipped order")

        order.status = OrderStatus.CANCELLED
        return order

    def list_orders(self, status: Optional[OrderStatus] = None) -> List[Order]:
        """List orders, optionally filtered by status."""
        orders = list(self._orders.values())
        if status:
            orders = [o for o in orders if o.status == status]
        return orders

    def get_order_total(self, order_id: int) -> float:
        """Calculate order total."""
        order = self._orders.get(order_id)
        if not order:
            raise ValidationError("Order not found")

        return sum(item.quantity * item.price for item in order.items)
