class BaseEntity {
  final int id;
  final DateTime createdAt;

  BaseEntity({required this.id, required this.createdAt});
}

class TimestampedEntity extends BaseEntity {
  final DateTime updatedAt;

  TimestampedEntity({
    required super.id,
    required super.createdAt,
    required this.updatedAt,
  });
}

class UserProfile extends TimestampedEntity {
  final String name;
  final String email;
  final int age;

  UserProfile({
    required super.id,
    required super.createdAt,
    required super.updatedAt,
    required this.name,
    required this.email,
    required this.age,
  });

  String getDisplayName() => name;
}

class CompanyInfo extends TimestampedEntity {
  final String title;
  final UserProfile owner;
  final String address;

  CompanyInfo({
    required super.id,
    required super.createdAt,
    required super.updatedAt,
    required this.title,
    required this.owner,
    required this.address,
  });

  UserProfile getOwner() => owner;
}
