using Xunit;

public sealed class OrderApiTests {
    [Fact]
    public void A_request_without_an_idempotency_key_is_refused() {
        var response = new OrderApi().Handle("POST", "/orders", new Dictionary<string, string>());

        Assert.Equal(400, response.Status);
    }
}
