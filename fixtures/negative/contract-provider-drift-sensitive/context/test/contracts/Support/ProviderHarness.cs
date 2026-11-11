public static class ProviderHarness {
    /// <summary>A provider that replays each interaction against a new TApi, after putting it in the state the interaction names.</summary>
    public static IContractProvider For<TApi>() where TApi : IApi, new() => new RealProvider<TApi>();

    private sealed class RealProvider<TApi> : IContractProvider where TApi : IApi, new() {
        public Task VerifyInteraction(ProviderInteraction interaction) {
            var api = new TApi();
            ProviderStates.Apply(interaction.Given, api);
            var response = api.Handle(interaction.Request.Method, interaction.Request.Path, interaction.Request.Headers);
            ContractAssert.Matches(interaction.Response, response.Status, response.Body);
            return Task.CompletedTask;
        }
    }
}
