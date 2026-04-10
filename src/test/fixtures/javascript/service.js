const { UserService, CompanyService } = require('./models');

/**
 * @param {string} name
 * @param {string} email
 * @returns {import('./models').UserProfile}
 */
function createUser(name, email) {
  const service = new UserService();
  return service.createUser({ id: 0, createdAt: new Date(), updatedAt: new Date(), name, email, age: 0 });
}

/**
 * @param {import('./models').CompanyInfo} company
 * @returns {import('./models').UserProfile}
 */
function getCompanyOwner(company) {
  const service = new CompanyService();
  return service.getOwner(company);
}

/**
 * @param {import('./models').BaseEntity} entity
 */
function processEntity(entity) {
  console.log(entity.id);
}

module.exports = { createUser, getCompanyOwner, processEntity };
