using System;

namespace Fixtures
{
    public class BaseEntity
    {
        public int Id { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    public class TimestampedEntity : BaseEntity
    {
        public DateTime UpdatedAt { get; set; }
    }

    public class UserProfile : TimestampedEntity
    {
        public string Name { get; set; }
        public string Email { get; set; }
        public int Age { get; set; }

        public string GetDisplayName()
        {
            return Name;
        }
    }

    public class CompanyInfo : TimestampedEntity
    {
        public string Title { get; set; }
        public UserProfile Owner { get; set; }
        public string Address { get; set; }

        public UserProfile GetOwner()
        {
            return Owner;
        }
    }
}
