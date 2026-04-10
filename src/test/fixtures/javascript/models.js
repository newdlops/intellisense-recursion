/**
 * @typedef {Object} BaseEntity
 * @property {number} id
 * @property {Date} createdAt
 */

/**
 * @typedef {BaseEntity & { updatedAt: Date }} TimestampedEntity
 */

/**
 * @typedef {TimestampedEntity & { name: string, email: string, age: number }} UserProfile
 */

/**
 * @typedef {TimestampedEntity & { title: string, owner: UserProfile, address: string }} CompanyInfo
 */

class UserService {
  /**
   * @param {number} id
   * @returns {UserProfile | null}
   */
  getUser(id) {
    return null;
  }

  /**
   * @param {UserProfile} profile
   * @returns {UserProfile}
   */
  createUser(profile) {
    return profile;
  }
}

class CompanyService {
  /**
   * @param {number} id
   * @returns {CompanyInfo | null}
   */
  getCompany(id) {
    return null;
  }

  /**
   * @param {CompanyInfo} company
   * @returns {UserProfile}
   */
  getOwner(company) {
    return company.owner;
  }
}

module.exports = { UserService, CompanyService };
