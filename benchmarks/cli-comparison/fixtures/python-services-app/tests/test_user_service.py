"""Tests for UserService - 10 tests."""

import pytest

from src.services.user_service import UserService, ValidationError


class TestUserServiceValidation:
    """Tests for validation methods."""

    def test_validate_email_valid(self):
        """Valid email is accepted and normalized."""
        service = UserService()
        result = service.validate_email("  Test@Example.COM  ")
        assert result == "test@example.com"

    def test_validate_email_empty_raises(self):
        """Empty email raises ValidationError."""
        service = UserService()
        with pytest.raises(ValidationError, match="Email is required"):
            service.validate_email("")

    def test_validate_email_invalid_format_raises(self):
        """Invalid email format raises ValidationError."""
        service = UserService()
        with pytest.raises(ValidationError, match="Invalid email format"):
            service.validate_email("not-an-email")

    def test_validate_phone_valid(self):
        """Valid phone is accepted and normalized."""
        service = UserService()
        result = service.validate_phone("(555) 123-4567")
        assert result == "+15551234567"

    def test_validate_phone_with_country_code(self):
        """Phone with country code is preserved."""
        service = UserService()
        result = service.validate_phone("+44 20 7946 0958")
        assert result == "+442079460958"

    def test_validate_phone_too_short_raises(self):
        """Short phone raises ValidationError."""
        service = UserService()
        with pytest.raises(ValidationError, match="Phone too short"):
            service.validate_phone("123")

    def test_validate_address_valid(self):
        """Valid address is accepted and normalized."""
        service = UserService()
        result = service.validate_address("  123   Main   Street  ")
        assert result == "123 Main Street"

    def test_validate_address_no_number_raises(self):
        """Address without street number raises ValidationError."""
        service = UserService()
        with pytest.raises(ValidationError, match="must contain a street number"):
            service.validate_address("Main Street Anytown")


class TestUserServiceCRUD:
    """Tests for CRUD operations."""

    def test_create_user_minimal(self):
        """Create user with only email."""
        service = UserService()
        user = service.create_user("test@example.com")
        assert user.id == 1
        assert user.email == "test@example.com"
        assert user.phone is None

    def test_create_user_full(self):
        """Create user with all fields."""
        service = UserService()
        user = service.create_user(
            email="test@example.com",
            phone="555-123-4567",
            address="123 Main St Anytown",
        )
        assert user.email == "test@example.com"
        assert user.phone == "+15551234567"
        assert user.address == "123 Main St Anytown"
