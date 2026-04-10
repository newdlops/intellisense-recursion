import {
  UserProfile, CompanyInfo, UserService, CompanyService, BaseEntity,
  Repository, AdminOrUser, AuditedEntity, ProfileMap, AdminProfile,
} from './models';

export function createUser(name: string, email: string): UserProfile {
  const service = new UserService();
  return service.createUser({ id: 0, createdAt: new Date(), updatedAt: new Date(), name, email, age: 0 });
}

export function getCompanyOwner(company: CompanyInfo): UserProfile {
  const service = new CompanyService();
  return service.getOwner(company);
}

export function processEntity(entity: BaseEntity): void {
  console.log(entity.id);
}

export function findEntity(data: any): BaseEntity | null {
  return null;
}

export function getOwnerName(company: CompanyInfo): string {
  return company.owner.name;
}

// §8.5 Import resolution: generics, union, intersection
export function getUserRepo(): Repository<UserProfile> {
  return { findById: () => null, findAll: () => [] };
}

export function processAdminOrUser(entity: AdminOrUser): void {
  console.log(entity.id);
}

export function auditEntity(entity: AuditedEntity): void {
  console.log(entity.auditLog);
}

export function getProfiles(): ProfileMap {
  return {};
}

// §8.6 Deep inheritance (4 levels)
export function processAdmin(admin: AdminProfile): void {
  console.log(admin.role);
}

// §8.7 Rejection targets: lowercase and camelCase
const userName = 'test';
const x = 1;
const myResult = findEntity(null);
