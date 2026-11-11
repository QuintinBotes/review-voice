public enum OrderState { Accepted, Pending }

public sealed record Order(string Id, OrderState State, string ParentId, DateTimeOffset CreatedAt);

public sealed record ApiResponse(int Status, Order? Body);

public interface IApi {
    ApiResponse Handle(string method, string path, IReadOnlyDictionary<string, string> headers);
}

public sealed class OrderApi : IApi {
    private readonly Dictionary<string, Order> _byIdempotencyKey = new();

    public void Seed(string idempotencyKey, Order order) => _byIdempotencyKey[idempotencyKey] = order;

    public ApiResponse Handle(string method, string path, IReadOnlyDictionary<string, string> headers) {
        if (method != "POST" || path != "/orders") return new ApiResponse(404, null);
        if (!headers.TryGetValue("Idempotency-Key", out var key)) return new ApiResponse(400, null);
        if (!_byIdempotencyKey.TryGetValue(key, out var order)) {
            order = new Order(Guid.NewGuid().ToString(), OrderState.Pending, "root", DateTimeOffset.UtcNow);
            _byIdempotencyKey[key] = order;
        }
        return new ApiResponse(200, order);
    }
}
