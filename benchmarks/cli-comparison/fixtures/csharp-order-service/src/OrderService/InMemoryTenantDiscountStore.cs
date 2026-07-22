namespace Example.OrderService;

/// <summary>
/// In-memory discount table seeded with a couple of tenants. Immutable after
/// construction, so a single shared instance is correct.
/// </summary>
public sealed class InMemoryTenantDiscountStore : ITenantDiscountStore
{
    private readonly IReadOnlyDictionary<string, decimal> _discounts = new Dictionary<string, decimal>
    {
        ["tenant-a"] = 0.10m,
        ["tenant-b"] = 0.20m,
    };

    public decimal GetDiscount(string tenantId)
    {
        return _discounts.TryGetValue(tenantId, out var discount) ? discount : 0m;
    }
}
