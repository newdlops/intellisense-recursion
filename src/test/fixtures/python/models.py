class BaseModel:
    """Base model with common fields."""
    id: int
    created_at: str

    def save(self) -> None:
        pass

    def delete(self) -> None:
        pass


class TimestampedModel(BaseModel):
    """Model with timestamp tracking."""
    updated_at: str


class User(TimestampedModel):
    """User account model."""
    name: str
    email: str
    age: int

    def get_display_name(self) -> str:
        return self.name


class Company(TimestampedModel):
    """Company entity."""
    title: str
    owner: User
    address: str

    def get_owner(self) -> User:
        return self.owner


class Stakeholder(BaseModel):
    """Stakeholder in a company."""
    company: Company
    user: User
    role: str
