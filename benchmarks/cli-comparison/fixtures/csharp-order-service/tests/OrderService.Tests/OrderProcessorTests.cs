using System.Collections.Concurrent;
using Example.OrderService;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Example.OrderService.Tests;

/// <summary>
/// Behavioral contract for the order-pricing service. These tests fail while the
/// singleton <see cref="OrderProcessor"/> captures scoped services and while
/// <see cref="ITenantContext"/> is registered as a singleton. They pass once the
/// captive dependency is removed (scope-per-order) and the tenant context is
/// registered with a scoped lifetime.
/// </summary>
public sealed class OrderProcessorTests
{
    private static ServiceProvider BuildProvider()
    {
        var services = new ServiceCollection();
        services.AddOrderServices();
        return services.BuildServiceProvider();
    }

    [Fact]
    public void Container_HasNoCaptiveDependencies()
    {
        var services = new ServiceCollection();
        services.AddOrderServices();

        var options = new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true,
        };

        // A singleton must not hold a scoped service. ValidateOnBuild surfaces the
        // captive dependency as an aggregate exception at build time.
        var exception = Record.Exception(() =>
        {
            using var provider = services.BuildServiceProvider(options);
        });

        Assert.Null(exception);
    }

    [Fact]
    public void TenantContext_IsScoped_NotShared()
    {
        using var provider = BuildProvider();

        using var scopeA = provider.CreateScope();
        using var scopeB = provider.CreateScope();

        var contextA = scopeA.ServiceProvider.GetRequiredService<ITenantContext>();
        var contextB = scopeB.ServiceProvider.GetRequiredService<ITenantContext>();

        // A per-request context must be a distinct instance in each scope.
        Assert.NotSame(contextA, contextB);
    }

    [Fact]
    public void ProcessOrder_AppliesTenantSpecificDiscount()
    {
        using var provider = BuildProvider();
        var processor = provider.GetRequiredService<OrderProcessor>();

        Assert.Equal(900, processor.ProcessOrder("tenant-a", 1000));
    }

    [Fact]
    public void ProcessOrder_DoesNotBleedTenantStateAcrossCalls()
    {
        using var provider = BuildProvider();
        var processor = provider.GetRequiredService<OrderProcessor>();

        // tenant-a: 10% off, tenant-b: 20% off, unknown: no discount.
        Assert.Equal(900, processor.ProcessOrder("tenant-a", 1000));
        Assert.Equal(800, processor.ProcessOrder("tenant-b", 1000));
        Assert.Equal(500, processor.ProcessOrder("tenant-unknown", 500));
    }

    [Fact]
    public void ProcessOrder_IsCorrectUnderConcurrentTenants()
    {
        using var provider = BuildProvider();
        var processor = provider.GetRequiredService<OrderProcessor>();

        var failures = new ConcurrentBag<string>();

        Parallel.For(0, 400, i =>
        {
            var isA = i % 2 == 0;
            var tenant = isA ? "tenant-a" : "tenant-b";
            var expected = isA ? 900 : 800;

            try
            {
                var actual = processor.ProcessOrder(tenant, 1000);
                if (actual != expected)
                {
                    failures.Add($"{tenant} expected {expected} got {actual}");
                }
            }
            catch (Exception ex)
            {
                failures.Add($"{tenant} threw {ex.GetType().Name}: {ex.Message}");
            }
        });

        Assert.Empty(failures);
    }
}
