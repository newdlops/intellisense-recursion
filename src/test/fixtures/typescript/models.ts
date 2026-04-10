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
