"""Integration tests across services - 4 tests."""


from src.services.admin_service import AdminService
from src.services.order_service import OrderService, OrderStatus
from src.services.user_service import UserService


class TestCrossServiceValidation:
    """Tests that validation is consistent across services."""

    def test_email_validation_consistent_across_services(self):
        """Email validation produces same result in all services."""
        test_email = "  CONSISTENT@Example.COM  "

        user_service = UserService()
        order_service = OrderService()
        admin_service = AdminService()

        user_result = user_service.validate_email(test_email)
        order_result = order_service.validate_email(test_email)
        admin_result = admin_service.validate_email(test_email)

        assert user_result == order_result == admin_result == "consistent@example.com"

    def test_address_validation_consistent_across_services(self):
        """Address validation produces same result in all services."""
        test_address = "  123   Test   Street   Suite 100  "

        user_service = UserService()
        order_service = OrderService()
        admin_service = AdminService()

        user_result = user_service.validate_address(test_address)
        order_result = order_service.validate_address(test_address)
        admin_result = admin_service.validate_address(test_address)

        assert user_result == order_result == admin_result == "123 Test Street Suite 100"

    def test_phone_validation_consistent_across_services(self):
        """Phone validation produces same result in user and admin services."""
        test_phone = "(555) 987-6543"

        user_service = UserService()
        admin_service = AdminService()

        user_result = user_service.validate_phone(test_phone)
        admin_result = admin_service.validate_phone(test_phone)

        assert user_result == admin_result == "+15559876543"


class TestServiceInteraction:
    """Tests for service interactions."""

    def test_user_can_place_order(self):
        """User created in UserService can place order in OrderService."""
        user_service = UserService()
        order_service = OrderService()

        # Create user
        user = user_service.create_user(
            email="buyer@example.com",
            phone="555-123-4567",
            address="123 Buyer Lane Apt 1",
        )

        # Place order using same email
        order = order_service.create_order(
            customer_email=user.email,
            shipping_address=user.address,
            items=[{"product_id": 1, "quantity": 1, "price": 99.99}],
        )

        assert order.customer_email == user.email
        assert order.shipping_address == user.address
        assert order.status == OrderStatus.PENDING
