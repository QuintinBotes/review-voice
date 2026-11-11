using Microsoft.EntityFrameworkCore;

public abstract class OrdersDbTest {
    private readonly string _database = Guid.NewGuid().ToString();

    protected OrdersDb CreateTrackedDb() => NewDb();

    protected Task<OrdersDb> OpenFreshDbConnection() => Task.FromResult(NewDb());

    protected static async Task<Order> SeedOrder(OrdersDb db) {
        var order = new Order { Id = Guid.NewGuid(), Status = OrderStatus.Pending };
        db.Orders.Add(order);
        await db.SaveChangesAsync();
        return order;
    }

    private OrdersDb NewDb() => new(new DbContextOptionsBuilder<OrdersDb>().UseInMemoryDatabase(_database).Options);
}
