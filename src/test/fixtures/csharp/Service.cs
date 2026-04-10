namespace Fixtures
{
    public class Service
    {
        public UserProfile CreateUser(string name, string email)
        {
            var user = new UserProfile();
            user.Name = name;
            user.Email = email;
            return user;
        }

        public UserProfile GetCompanyOwner(CompanyInfo company)
        {
            return company.GetOwner();
        }

        public void ProcessEntity(BaseEntity entity)
        {
            Console.WriteLine(entity.Id);
        }

        public TimestampedEntity GetTimestamped(int id)
        {
            return new TimestampedEntity();
        }
    }
}
