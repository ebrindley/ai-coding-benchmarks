using Microsoft.Extensions.DependencyInjection;

namespace Example.OrderService;

/// <summary>
/// Application entry point for pricing an order on behalf of a tenant.
/// Registered as a Singleton; each order must have isolated scoped tenant state.
/// </summary>
public sealed class OrderProcessor
{
    private readonly PricingService _pricing;
    private readonly ITenantContext _tenantContext;

    public OrderProcessor(PricingService pricing, ITenantContext tenantContext)
    {
        _pricing = pricing;
        _tenantContext = tenantContext;
    }

    /// <summary>
    /// Prices an order for <paramref name="tenantId"/>: assigns the tenant onto
    /// the request context and applies that tenant's discount to
    /// <paramref name="cents"/>, returning the net total in cents.
    /// </summary>
    public int ProcessOrder(string tenantId, int cents)
    {
        if (string.IsNullOrWhiteSpace(tenantId))
        {
            throw new ArgumentException("tenantId is required", nameof(tenantId));
        }

        _tenantContext.TenantId = tenantId;
        return _pricing.ComputeTotal(cents);
    }
}
