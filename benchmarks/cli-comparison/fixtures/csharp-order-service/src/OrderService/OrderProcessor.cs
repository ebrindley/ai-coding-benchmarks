using Microsoft.Extensions.DependencyInjection;

namespace Example.OrderService;

/// <summary>
/// Application entry point for pricing an order on behalf of a tenant. This type
/// is registered as a <c>Singleton</c> because it is stateless coordination
/// logic that should live for the lifetime of the process.
///
/// BUG: a singleton must not hold per-request (scoped) services directly. This
/// implementation injects the scoped <see cref="PricingService"/> and
/// <see cref="ITenantContext"/> into its constructor, capturing a single scoped
/// instance for the whole process lifetime (a "captive dependency"). Because the
/// captured <see cref="ITenantContext"/> is reused for every call, tenant state
/// set by one request bleeds into the next, and the scoped services are never
/// released. The fix is to depend on <see cref="IServiceScopeFactory"/> and open
/// a fresh scope per order instead of capturing scoped services.
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
