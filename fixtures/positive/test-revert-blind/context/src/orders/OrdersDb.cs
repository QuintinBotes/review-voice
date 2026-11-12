using Microsoft.EntityFrameworkCore;

public enum OrderStatus { Pending, Paid }

public sealed class Order {
    public Guid Id { get; set; }
    public OrderStatus Status { get; set; }
}

public sealed class OrdersDb(DbContextOptions<OrdersDb> options) : DbContext(options) {
    public DbSet<Order> Orders => Set<Order>();
}
