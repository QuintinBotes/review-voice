public sealed record Item(string Name);

public sealed record Page(IReadOnlyList<Item> Items, string? NextCursor);

public interface ICatalogClient {
    Task<Page> GetPageAsync(string? cursor, int pageSize, CancellationToken cancellationToken);
}
