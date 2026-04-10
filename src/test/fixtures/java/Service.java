public class Service {
    public UserProfile createUser(String name, String email) {
        UserProfile user = new UserProfile();
        user.setName(name);
        user.setEmail(email);
        return user;
    }

    public void processEntity(BaseEntity entity) {
        System.out.println(entity.getId());
    }

    public TimestampedEntity getTimestamped(int id) {
        return new TimestampedEntity();
    }
}
