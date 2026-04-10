use crate::models::{BaseEntity, TimestampedEntity, UserProfile, CompanyInfo};
use std::time::SystemTime;

fn create_user(name: &str, email: &str) -> UserProfile {
    UserProfile {
        entity: TimestampedEntity {
            base: BaseEntity {
                id: 0,
                created_at: SystemTime::now(),
            },
            updated_at: SystemTime::now(),
        },
        name: name.to_string(),
        email: email.to_string(),
        age: 0,
    }
}

fn get_company_owner(company: &CompanyInfo) -> &UserProfile {
    company.get_owner()
}

fn process_entity(entity: &BaseEntity) {
    println!("{}", entity.id);
}
