var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddSingleton<IAccountStore, AccountStore>();
builder.Services.AddAuthentication().AddJwtBearer();
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("AnyAuthenticatedService", policy => policy.RequireAuthenticatedUser());
    options.AddPolicy("AccountWriter", policy => policy.RequireRole("AccountWriter"));
});

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.Run();

public partial class Program { }
