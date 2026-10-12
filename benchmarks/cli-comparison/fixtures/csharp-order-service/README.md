# csharp-order-service fixture

Brownfield C# (.NET 8) fixture: a multi-tenant order-pricing service wired with
`Microsoft.Extensions.DependencyInjection`. It has a seeded
dependency-injection lifetime bug that spans two files.

The service prices an order for a tenant by applying that tenant's discount:
`OrderProcessor` sets the current tenant on an `ITenantContext`, then
`PricingService` reads that context and the shared `ITenantDiscountStore` to
compute the net total.

## Symptoms

Pricing a second tenant on the same `OrderProcessor` throws `tenant already assigned`; per-tenant discounts do not remain isolated across calls.

## Constraints

- Keep `OrderProcessor` registered as a singleton and its public `ProcessOrder(string, int)` signature unchanged.
- `ITenantContext` and `PricingService` must be scoped, with isolated tenant state for each order.
- Preserve the parallel-safe per-request scoping model.

## Layout

```
src/OrderService/          class library (net8.0), the bug lives here
tests/OrderService.Tests/  xUnit test project (net8.0)
scripts/                   static checks used by the task gates
OrderService.sln           solution referencing both projects
```

## Run

```sh
dotnet build -c Release
dotnet test
```

Do not edit anything under `tests/`.
