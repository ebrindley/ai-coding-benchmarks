using Microsoft.Extensions.DependencyInjection;

namespace Example.OrderService;

/// <summary>
/// Composition root for the order-pricing service. All lifetimes are declared
/// here.
///
/// BUG: <see cref="ITenantContext"/> is registered as a <c>Singleton</c>. It
/// carries per-request tenant state, so it must be <c>Scoped</c> — one instance
/// per request/scope. Registered as a singleton, every scope shares the same
/// tenant context and tenant state leaks across requests. Correct lifetimes:
///   - ITenantDiscountStore : Singleton (immutable, shared)  -- correct
///   - ITenantContext       : Scoped    (per-request state)  -- WRONG below
///   - PricingService       : Scoped    (uses ITenantContext) -- correct
///   - OrderProcessor       : Singleton (stateless coordinator) -- correct
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddOrderServices(this IServiceCollection services)
    {
        services.AddSingleton<ITenantDiscountStore, InMemoryTenantDiscountStore>();

        // BUG: per-request state registered as a singleton — should be AddScoped.
        services.AddSingleton<ITenantContext, TenantContext>();

        services.AddScoped<PricingService>();
        services.AddSingleton<OrderProcessor>();

        return services;
    }
}
