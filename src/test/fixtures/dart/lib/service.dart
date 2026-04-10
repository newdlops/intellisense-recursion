import 'models.dart';

UserProfile createUser(String name, String email) {
  return UserProfile(
    id: 0,
    createdAt: DateTime.now(),
    updatedAt: DateTime.now(),
    name: name,
    email: email,
    age: 0,
  );
}

UserProfile getCompanyOwner(CompanyInfo company) {
  return company.getOwner();
}

void processEntity(BaseEntity entity) {
  print(entity.id);
}

TimestampedEntity getTimestamped(int id) {
  return TimestampedEntity(
    id: id,
    createdAt: DateTime.now(),
    updatedAt: DateTime.now(),
  );
}
