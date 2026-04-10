import { UserProfile, CompanyInfo, UserService, CompanyService, BaseEntity } from './models';

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
