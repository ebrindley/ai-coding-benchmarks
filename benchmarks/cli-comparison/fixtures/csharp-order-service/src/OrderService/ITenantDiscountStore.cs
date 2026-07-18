namespace Example.OrderService;

/// <summary>
/// Immutable per-tenant discount configuration. Shared across all tenants and
/// requests, so it is safe (and intended) to register as a singleton.
/// </summary>
public interface ITenantDiscountStore
{
    /// <summary>
    /// Fractional discount for the tenant (for example, 0.10 == 10% off).
    /// Unknown tenants receive no discount.
    /// </summary>
    decimal GetDiscount(string tenantId);
}
