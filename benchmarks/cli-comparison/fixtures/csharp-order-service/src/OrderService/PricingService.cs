namespace Example.OrderService;

/// <summary>
/// Computes an order total for the current tenant. Depends on the per-request
/// <see cref="ITenantContext"/>, so it must be registered with a <c>Scoped</c>
/// lifetime and resolved inside a scope.
/// </summary>
public sealed class PricingService
{
    private readonly ITenantContext _tenantContext;
    private readonly ITenantDiscountStore _discounts;

    public PricingService(ITenantContext tenantContext, ITenantDiscountStore discounts)
    {
        _tenantContext = tenantContext;
        _discounts = discounts;
    }

    /// <summary>
    /// Applies the current tenant's discount to a gross amount expressed in
    /// integer cents and returns the net total in cents.
    /// </summary>
    public int ComputeTotal(int cents)
    {
        if (cents < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(cents), "amount must be non-negative");
        }

        var discount = _discounts.GetDiscount(_tenantContext.TenantId);
        var reduction = (int)Math.Round(cents * discount, MidpointRounding.AwayFromZero);
        return cents - reduction;
    }
}
