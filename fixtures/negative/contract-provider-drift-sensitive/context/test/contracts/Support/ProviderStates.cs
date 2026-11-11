public static class ProviderStates {
    public static void Apply(string given, IApi api) {
        switch (given, api) {
            case ("order with idempotency key repeat-key has id order-42", OrderApi orders):
                orders.Seed("repeat-key", new Order("order-42", OrderState.Accepted, "parent-7", DateTimeOffset.UnixEpoch));
                break;
            default:
                throw new ContractException($"No provider state is named \"{given}\".");
        }
    }
}
