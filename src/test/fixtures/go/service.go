package main

import "fmt"

func CreateUser(name string, email string) UserProfile {
	user := UserProfile{}
	user.Name = name
	user.Email = email
	return user
}

func GetCompanyOwner(company CompanyInfo) UserProfile {
	return company.Owner
}

func ProcessEntity(entity BaseEntity) {
	fmt.Println(entity.ID)
}

func GetTimestamped(id int) TimestampedEntity {
	return TimestampedEntity{}
}
