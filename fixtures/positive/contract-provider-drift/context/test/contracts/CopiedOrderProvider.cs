/// <summary>The submit handler as it was when the contracts were first written, kept here so they run without the API project.</summary>
public sealed class CopiedOrderProvider : IContractProvider {
    private sealed record CopiedOrder(string Id, string State, string? ParentId);

    private readonly Dictionary<string, CopiedOrder> _byIdempotencyKey = new();

    public Task VerifyInteraction(ProviderInteraction interaction) {
        if (interaction.Given == "an order already exists") {
            _byIdempotencyKey["existing-key"] = new CopiedOrder("order-1", "Accepted", null);
        }
        var key = interaction.Request.Headers["Idempotency-Key"];
        if (!_byIdempotencyKey.TryGetValue(key, out var order)) {
            order = new CopiedOrder(Guid.NewGuid().ToString(), "Accepted", null);
            _byIdempotencyKey[key] = order;
        }
        ContractAssert.Matches(interaction.Response, 200, order);
        return Task.CompletedTask;
    }
}
