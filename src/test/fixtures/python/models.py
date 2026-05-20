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
    STATUS_ACTIVE = "active"
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


# §8.6 Deep inheritance (4 levels: BaseModel → TimestampedModel → AuditModel → AdminUser)
class AuditModel(TimestampedModel):
    """Model with audit logging."""
    audit_log: str


class AdminUser(AuditModel):
    """Admin user with role."""
    role: str
    permissions: str


# §8.6 Assignment-style definition
UserOrCompany = User


class LargeHoverModel(BaseModel):
    """Large model used by renderer hover sizing and scroll E2E."""
    field_001: str
    field_002: str
    field_003: str
    field_004: str
    field_005: str
    field_006: str
    field_007: str
    field_008: str
    field_009: str
    field_010: str
    field_011: str
    field_012: str
    field_013: str
    field_014: str
    field_015: str
    field_016: str
    field_017: str
    field_018: str
    field_019: str
    field_020: str
    field_021: str
    field_022: str
    field_023: str
    field_024: str
    field_025: str
    field_026: str
    field_027: str
    field_028: str
    field_029: str
    field_030: str
    field_031: str
    field_032: str
    field_033: str
    field_034: str
    field_035: str
    field_036: str
    field_037: str
    field_038: str
    field_039: str
    field_040: str
    field_041: str
    field_042: str
    field_043: str
    field_044: str
    field_045: str
    field_046: str
    field_047: str
    field_048: str
    field_049: str
    field_050: str
    field_051: str
    field_052: str
    field_053: str
    field_054: str
    field_055: str
    field_056: str
    field_057: str
    field_058: str
    field_059: str
    field_060: str
    field_061: str
    field_062: str
    field_063: str
    field_064: str
    field_065: str
    field_066: str
    field_067: str
    field_068: str
    field_069: str
    field_070: str
