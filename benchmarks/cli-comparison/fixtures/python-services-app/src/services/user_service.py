"""User service with user management operations."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class User:
    id: int
    email: str
    phone: Optional[str]
    address: Optional[str]


class ValidationError(Exception):
    """Raised when validation fails."""

    pass


class UserService:
    """Service for user management operations."""

    def __init__(self, repository=None):
        self._repository = repository
        self._users: Dict[int, User] = {}
        self._next_id = 1

    # -------------------------------------------------------------------------
    # DUPLICATE VALIDATION LOGIC (appears in order_service.py, admin_service.py)
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

    def create_user(
        self, email: str, phone: Optional[str] = None, address: Optional[str] = None
    ) -> User:
        """Create a new user.

        Args:
            email: User's email address
            phone: Optional phone number
            address: Optional address

        Returns:
            Created user object
        """
        validated_email = self.validate_email(email)

        validated_phone = None
        if phone:
            validated_phone = self.validate_phone(phone)

        validated_address = None
        if address:
            validated_address = self.validate_address(address)

        user = User(
            id=self._next_id,
            email=validated_email,
            phone=validated_phone,
            address=validated_address,
        )
        self._users[user.id] = user
        self._next_id += 1

        return user

    def get_user(self, user_id: int) -> Optional[User]:
        """Get user by ID."""
        return self._users.get(user_id)

    def update_email(self, user_id: int, email: str) -> User:
        """Update user's email."""
        user = self._users.get(user_id)
        if not user:
            raise ValidationError("User not found")

        validated_email = self.validate_email(email)
        user.email = validated_email
        return user

    def update_phone(self, user_id: int, phone: str) -> User:
        """Update user's phone."""
        user = self._users.get(user_id)
        if not user:
            raise ValidationError("User not found")

        validated_phone = self.validate_phone(phone)
        user.phone = validated_phone
        return user

    def update_address(self, user_id: int, address: str) -> User:
        """Update user's address."""
        user = self._users.get(user_id)
        if not user:
            raise ValidationError("User not found")

        validated_address = self.validate_address(address)
        user.address = validated_address
        return user

    def list_users(self) -> List[User]:
        """List all users."""
        return list(self._users.values())

    def delete_user(self, user_id: int) -> bool:
        """Delete user by ID."""
        if user_id in self._users:
            del self._users[user_id]
            return True
        return False
