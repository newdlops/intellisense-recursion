export interface BaseEntity {
  id: number;
  createdAt: Date;
}

export interface TimestampedEntity extends BaseEntity {
  updatedAt: Date;
}

export interface UserProfile extends TimestampedEntity {
  name: string;
  email: string;
  age: number;
}

export interface CompanyInfo extends TimestampedEntity {
  title: string;
  owner: UserProfile;
  address: string;
}

export class UserService {
  getUser(id: number): UserProfile | null {
    return null;
  }

  createUser(profile: UserProfile): UserProfile {
    return profile;
  }
}

export class CompanyService {
  getCompany(id: number): CompanyInfo | null {
    return null;
  }

  getOwner(company: CompanyInfo): UserProfile {
    return company.owner;
  }
}

// §8.6 Edge Cases: Generics
export interface Repository<T extends BaseEntity> {
  findById(id: number): T | null;
  findAll(): T[];
}

// §8.6 Edge Cases: Union & Intersection types
export type AdminOrUser = UserProfile | CompanyInfo;
export type AuditedEntity = BaseEntity & { auditLog: string[] };

// §8.6 Edge Cases: Assignment-style type alias
export type ProfileMap = Record<string, UserProfile>;

// §8.6 Edge Cases: Deep inheritance (4 levels)
export interface AuditedTimestampedEntity extends TimestampedEntity {
  auditLog: string[];
}

export interface AdminProfile extends AuditedTimestampedEntity {
  role: string;
  permissions: string[];
}
