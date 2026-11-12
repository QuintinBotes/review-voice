using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

/// <summary>
/// Hosts the API in process over two seeded accounts. Every client it hands out is signed in as a service,
/// with the roles asked for.
/// </summary>
public sealed class ApiClientFactory : WebApplicationFactory<Program>
{
    private static readonly IReadOnlyList<Account> SeededAccounts =
    [
        new("account-1", "Active", "Asked for a paper statement", "First Owner"),
        new("account-2", "Suspended", "Card reported lost", "Second Owner"),
    ];

    public HttpClient WithoutRole() => WithRoles();

    public HttpClient ForRole(string role) => WithRoles(role);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<IAccountStore>(new SeededAccountStore());
            services
                .AddAuthentication(RoleHeaderHandler.SchemeName)
                .AddScheme<AuthenticationSchemeOptions, RoleHeaderHandler>(RoleHeaderHandler.SchemeName, _ => { });
        });
    }

    private HttpClient WithRoles(params string[] roles)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add("X-Test-Roles", string.Join(',', roles));
        return client;
    }

    private sealed class SeededAccountStore : IAccountStore
    {
        public Task<IReadOnlyList<Account>> ReadAll() => Task.FromResult(SeededAccounts);
    }

    private sealed class RoleHeaderHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        public const string SchemeName = "TestRoles";

        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var roles = Request.Headers["X-Test-Roles"].ToString().Split(',', StringSplitOptions.RemoveEmptyEntries);
            var claims = roles.Select(role => new Claim(ClaimTypes.Role, role)).Append(new Claim(ClaimTypes.Name, "test-service"));
            var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
        }
    }
}
