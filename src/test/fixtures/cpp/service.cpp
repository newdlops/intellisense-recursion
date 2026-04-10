#include "models.h"
#include <iostream>

UserProfile createUser(const std::string& name, const std::string& email) {
    UserProfile user;
    user.name = name;
    user.email = email;
    user.age = 0;
    return user;
}

UserProfile getCompanyOwner(const CompanyInfo& company) {
    return company.getOwner();
}

void processEntity(const BaseEntity& entity) {
    std::cout << entity.id << std::endl;
}

TimestampedEntity getTimestamped(int id) {
    TimestampedEntity entity;
    entity.id = id;
    return entity;
}
