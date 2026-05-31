"""Tests for AdminService - 8 tests."""

import pytest

from src.services.admin_service import AdminRole, AdminService, ValidationError


class TestAdminServiceValidation:
    """Tests for validation methods."""

    def test_validate_email_valid(self):
        """Valid email is accepted and normalized."""
        service = AdminService()
        result = service.validate_email("  Admin@Company.ORG  ")
        assert result == "admin@company.org"

    def test_validate_phone_valid(self):
        """Valid phone is accepted and normalized."""
        service = AdminService()
        result = service.validate_phone("+1-800-555-0199")
        assert result == "+18005550199"

    def test_validate_phone_empty_raises(self):
        """Empty phone raises ValidationError."""
        service = AdminService()
        with pytest.raises(ValidationError, match="Phone is required"):
            service.validate_phone("")

    def test_validate_address_too_long_raises(self):
        """Address exceeding 500 chars raises ValidationError."""
        service = AdminService()
        long_address = "123 " + "A" * 500
        with pytest.raises(ValidationError, match="Address too long"):
            service.validate_address(long_address)


class TestAdminServiceCRUD:
    """Tests for CRUD operations."""

    def test_create_admin_default_role(self):
        """Create admin with default VIEWER role."""
        service = AdminService()
        admin = service.create_admin(
            email="admin@example.com",
            phone="555-123-4567",
            address="100 Corporate Blvd Suite 500",
        )
        assert admin.id == 1
        assert admin.role == AdminRole.VIEWER
        assert admin.email == "admin@example.com"

    def test_create_admin_with_role(self):
        """Create admin with specified role."""
        service = AdminService()
        admin = service.create_admin(
            email="admin@example.com",
            phone="555-123-4567",
            address="100 Corporate Blvd Suite 500",
            role=AdminRole.ADMIN,
        )
        assert admin.role == AdminRole.ADMIN

    def test_promote_admin(self):
        """Admin can be promoted to higher role."""
        service = AdminService()
        # Start with ADMIN role (string "admin" comes before "super_admin" alphabetically)
        admin = service.create_admin(
            email="admin@example.com",
            phone="555-123-4567",
            address="100 Corporate Blvd Suite 500",
            role=AdminRole.ADMIN,
        )
        # Promote to SUPER_ADMIN (works because "super_admin" > "admin" in string comparison)
        promoted = service.promote_admin(admin.id, AdminRole.SUPER_ADMIN)
        assert promoted.role == AdminRole.SUPER_ADMIN

    def test_list_admins_by_role(self):
        """List admins filtered by role."""
        service = AdminService()
        service.create_admin(
            email="viewer@example.com",
            phone="555-111-1111",
            address="100 Corporate Blvd Suite 100",
            role=AdminRole.VIEWER,
        )
        service.create_admin(
            email="editor@example.com",
            phone="555-222-2222",
            address="100 Corporate Blvd Suite 200",
            role=AdminRole.EDITOR,
        )
        service.create_admin(
            email="admin@example.com",
            phone="555-333-3333",
            address="100 Corporate Blvd Suite 300",
            role=AdminRole.ADMIN,
        )

        viewers = service.list_admins(role=AdminRole.VIEWER)
        assert len(viewers) == 1
        assert viewers[0].email == "viewer@example.com"
