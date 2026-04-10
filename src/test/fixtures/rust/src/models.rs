use std::time::SystemTime;

pub struct BaseEntity {
    pub id: i32,
    pub created_at: SystemTime,
}

pub struct TimestampedEntity {
    pub base: BaseEntity,
    pub updated_at: SystemTime,
}

pub struct UserProfile {
    pub entity: TimestampedEntity,
    pub name: String,
    pub email: String,
    pub age: i32,
}

pub struct CompanyInfo {
    pub entity: TimestampedEntity,
    pub title: String,
    pub owner: UserProfile,
    pub address: String,
}

impl UserProfile {
    pub fn get_display_name(&self) -> &str {
        &self.name
    }
}

impl CompanyInfo {
    pub fn get_owner(&self) -> &UserProfile {
        &self.owner
    }
}
