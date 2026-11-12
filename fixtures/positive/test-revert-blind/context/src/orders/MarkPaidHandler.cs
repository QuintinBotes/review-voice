using Microsoft.EntityFrameworkCore;

public sealed record MarkPaid(Guid OrderId);

public sealed class MarkPaidHandler {
    private readonly OrdersDb _db;

    public MarkPaidHandler(OrdersDb db) {
        _db = db;
    }

    public async Task Handle(MarkPaid command, CancellationToken cancellationToken) {
        var order = await _db.Orders.SingleAsync(o => o.Id == command.OrderId, cancellationToken);
        order.Status = OrderStatus.Paid;
    }
}
