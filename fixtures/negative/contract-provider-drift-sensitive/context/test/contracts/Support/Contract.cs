using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class ContractRequest {
    public required string Method { get; init; }
    public required string Path { get; init; }
    public Dictionary<string, string> Headers { get; init; } = new();
}

public sealed class ContractResponse {
    public required int Status { get; init; }
    public object? Body { get; init; }
}

public sealed class ProviderInteraction {
    public required string Given { get; init; }
    public required ContractRequest Request { get; init; }
    public required ContractResponse Response { get; init; }
}

public interface IContractProvider {
    Task VerifyInteraction(ProviderInteraction interaction);
}

public abstract record Matcher {
    public abstract bool Matches(JsonElement actual);
}

public static class Match {
    /// <summary>Any value of the JSON type the example has.</summary>
    public static Matcher Type(object example) => new TypeMatcher(JsonSerializer.SerializeToElement(example).ValueKind);

    public static Matcher OneOf(params string[] values) => new OneOfMatcher(values);

    public static Matcher Iso8601DateTime() => new Iso8601Matcher();

    private sealed record TypeMatcher(JsonValueKind Kind) : Matcher {
        public override bool Matches(JsonElement actual) => actual.ValueKind == Kind;
    }

    private sealed record OneOfMatcher(string[] Values) : Matcher {
        public override bool Matches(JsonElement actual) => actual.ValueKind == JsonValueKind.String && Values.Contains(actual.GetString());
    }

    private sealed record Iso8601Matcher : Matcher {
        public override bool Matches(JsonElement actual) => actual.ValueKind == JsonValueKind.String && actual.TryGetDateTimeOffset(out _);
    }
}

public sealed class ContractException(string message) : Exception(message);

public static class ContractAssert {
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    /// <summary>A body property is compared by its matcher, and by equality when the contract gives a plain value.</summary>
    public static void Matches(ContractResponse expected, int status, object? body) {
        if (status != expected.Status) throw new ContractException($"Expected status {expected.Status}, got {status}.");
        if (expected.Body is null) return;
        var actual = JsonSerializer.SerializeToElement(body, Json);
        if (actual.ValueKind != JsonValueKind.Object) throw new ContractException("The response has no body.");
        foreach (var property in expected.Body.GetType().GetProperties()) {
            var found = actual.TryGetProperty(property.Name, out var value);
            var matches = property.GetValue(expected.Body) switch {
                Matcher matcher => found && matcher.Matches(value),
                null => !found || value.ValueKind == JsonValueKind.Null,
                var example => found && value.ToString() == example.ToString(),
            };
            if (!matches) throw new ContractException($"The response body does not match the contract at {property.Name}.");
        }
    }
}
