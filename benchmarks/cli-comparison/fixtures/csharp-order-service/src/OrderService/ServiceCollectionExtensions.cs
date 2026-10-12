using Microsoft.Extensions.DependencyInjection;

namespace Example.OrderService;

/// <summary>
/// Composition root for the order-pricing service.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddOrderServices(this IServiceCollection services)
    {
        services.AddSingleton<ITenantDiscountStore, InMemoryTenantDiscountStore>();

        services.AddSingleton<ITenantContext, TenantContext>();

        services.AddScoped<PricingService>();
        services.AddSingleton<OrderProcessor>();

        return services;
    }
}
