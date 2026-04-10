#pragma once
#include <string>
#include <ctime>

class BaseEntity {
public:
    int id;
    std::time_t createdAt;

    virtual ~BaseEntity() = default;
};

class TimestampedEntity : public BaseEntity {
public:
    std::time_t updatedAt;
};

class UserProfile : public TimestampedEntity {
public:
    std::string name;
    std::string email;
    int age;

    std::string getDisplayName() const {
        return name;
    }
};

class CompanyInfo : public TimestampedEntity {
public:
    std::string title;
    UserProfile owner;
    std::string address;

    UserProfile getOwner() const {
        return owner;
    }
};
