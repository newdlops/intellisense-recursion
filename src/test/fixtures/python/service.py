from typing import Any, Optional
from models import User, Company, Stakeholder, BaseModel, AdminUser, AuditModel


def create_user(name: str, email: str) -> User:
    """Create a new user."""
    user = User()
    user.name = name
    user.email = email
    return user


def get_company_stakeholders(company: Company) -> list[Stakeholder]:
    """Get all stakeholders for a company."""
    return []


def process_model(model: BaseModel) -> None:
    """Process any base model."""
    model.save()


def find_entity(data: Any) -> Optional[BaseModel]:
    """Find any entity from raw data. Returns None if not found."""
    return None


def get_display_name(user: User) -> str:
    """Call overridden method on inherited class."""
    return user.get_display_name()


def process_admin(admin: AdminUser) -> None:
    """Process admin user (deep inheritance: BaseModel → TimestampedModel → AuditModel → AdminUser)."""
    admin.save()


def audit_model(model: AuditModel) -> None:
    """Process audited model."""
    model.save()


# §8.7 Rejection targets
my_var = create_user("a", "b")
x = 1
