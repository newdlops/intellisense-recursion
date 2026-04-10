package main

import "time"

type BaseEntity struct {
	ID        int       `json:"id"`
	CreatedAt time.Time `json:"created_at"`
}

type TimestampedEntity struct {
	BaseEntity
	UpdatedAt time.Time `json:"updated_at"`
}

type UserProfile struct {
	TimestampedEntity
	Name  string `json:"name"`
	Email string `json:"email"`
	Age   int    `json:"age"`
}

type CompanyInfo struct {
	TimestampedEntity
	Title   string      `json:"title"`
	Owner   UserProfile `json:"owner"`
	Address string      `json:"address"`
}
