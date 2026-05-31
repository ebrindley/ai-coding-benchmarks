"""Admin service with administrative operations."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional


class AdminRole(Enum):
    VIEWER = "viewer"
    EDITOR = "editor"
    ADMIN = "admin"
    SUPER_ADMIN = "super_admin"


@dataclass
class AdminUser:
    id: int
    email: str
    phone: str
    address: str
    role: AdminRole
    created_at: datetime


class ValidationError(Exception):
    """Raised when validation fails."""

    pass


class AdminService:
    """Service for administrative operations."""

    def __init__(self, audit_logger=None):
        self._audit = audit_logger
        self._admins: Dict[int, AdminUser] = {}
        self._next_id = 1

    # -------------------------------------------------------------------------
    # DUPLICATE VALIDATION LOGIC (appears in user_service.py, order_service.py)
    # Note: This version has slightly different whitespace handling
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

        # Extra strip for tabs and newlines (slight variation)
        email = email.strip().lower()

        # Basic email pattern
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        if not re.match(pattern, email):
            raise ValidationError("Invalid email format")

        if len(email) > 254:
            raise ValidationError("Email too long")

        return email

    def validate_phone(self, phone: str) -> str:
        """Validate and normalize phone number.

        Args:
            phone: Phone number to validate

        Returns:
            Normalized phone (digits only, with country code)

        Raises:
            ValidationError: If phone is invalid
        """
        if not phone:
            raise ValidationError("Phone is required")

        # Strip whitespace first
        phone = phone.strip()

        # Remove common separators
        digits = re.sub(r"[\s\-\.\(\)]+", "", phone)

        # Handle + prefix
        if digits.startswith("+"):
            digits = digits[1:]

        if not digits.isdigit():
            raise ValidationError("Phone must contain only digits")

        if len(digits) < 10:
            raise ValidationError("Phone too short")

        if len(digits) > 15:
            raise ValidationError("Phone too long")

        # Add country code if missing (assume US)
        if len(digits) == 10:
            digits = "1" + digits

        return "+" + digits

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

    def create_admin(
        self, email: str, phone: str, address: str, role: AdminRole = AdminRole.VIEWER
    ) -> AdminUser:
        """Create a new admin user.

        Args:
            email: Admin's email address
            phone: Admin's phone number
            address: Admin's address
            role: Admin role (default: VIEWER)

        Returns:
            Created admin user object
        """
        validated_email = self.validate_email(email)
        validated_phone = self.validate_phone(phone)
        validated_address = self.validate_address(address)

        admin = AdminUser(
            id=self._next_id,
            email=validated_email,
            phone=validated_phone,
            address=validated_address,
            role=role,
            created_at=datetime.now(),
        )
        self._admins[admin.id] = admin
        self._next_id += 1

        return admin

    def get_admin(self, admin_id: int) -> Optional[AdminUser]:
        """Get admin user by ID."""
        return self._admins.get(admin_id)

    def update_email(self, admin_id: int, email: str) -> AdminUser:
        """Update admin's email."""
        admin = self._admins.get(admin_id)
        if not admin:
            raise ValidationError("Admin not found")

        validated_email = self.validate_email(email)
        admin.email = validated_email
        return admin

    def update_phone(self, admin_id: int, phone: str) -> AdminUser:
        """Update admin's phone."""
        admin = self._admins.get(admin_id)
        if not admin:
            raise ValidationError("Admin not found")

        validated_phone = self.validate_phone(phone)
        admin.phone = validated_phone
        return admin

    def update_address(self, admin_id: int, address: str) -> AdminUser:
        """Update admin's address."""
        admin = self._admins.get(admin_id)
        if not admin:
            raise ValidationError("Admin not found")

        validated_address = self.validate_address(address)
        admin.address = validated_address
        return admin

    def promote_admin(self, admin_id: int, new_role: AdminRole) -> AdminUser:
        """Promote admin to a new role."""
        admin = self._admins.get(admin_id)
        if not admin:
            raise ValidationError("Admin not found")

        if new_role.value <= admin.role.value:
            raise ValidationError("New role must be higher than current role")

        admin.role = new_role
        return admin

    def demote_admin(self, admin_id: int, new_role: AdminRole) -> AdminUser:
        """Demote admin to a lower role."""
        admin = self._admins.get(admin_id)
        if not admin:
            raise ValidationError("Admin not found")

        admin.role = new_role
        return admin

    def list_admins(self, role: Optional[AdminRole] = None) -> List[AdminUser]:
        """List admin users, optionally filtered by role."""
        admins = list(self._admins.values())
        if role:
            admins = [a for a in admins if a.role == role]
        return admins

    def delete_admin(self, admin_id: int) -> bool:
        """Delete admin user by ID."""
        if admin_id in self._admins:
            del self._admins[admin_id]
            return True
        return False

    def get_admins_by_role(self, role: AdminRole) -> List[AdminUser]:
        """Get all admins with a specific role."""
        return [a for a in self._admins.values() if a.role == role]
