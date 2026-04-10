from models import User, Company, Stakeholder, BaseModel


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
