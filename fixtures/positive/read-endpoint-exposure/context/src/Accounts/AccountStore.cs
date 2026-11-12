/// <summary>An account as it is stored. Note is free text written by support staff.</summary>
public sealed record Account(string Id, string Status, string Note, string OwnerDisplayName);

public interface IAccountStore
{
    Task<IReadOnlyList<Account>> ReadAll();
}

public sealed class AccountStore : IAccountStore
{
    private readonly List<Account> _accounts = new();

    public Task<IReadOnlyList<Account>> ReadAll() => Task.FromResult<IReadOnlyList<Account>>(_accounts.ToList());
}
