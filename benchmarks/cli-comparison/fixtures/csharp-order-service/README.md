# csharp-order-service fixture

Brownfield C# (.NET 8) fixture: a multi-tenant order-pricing service wired with
`Microsoft.Extensions.DependencyInjection`. It has a seeded
dependency-injection lifetime bug that spans two files.

The service prices an order for a tenant by applying that tenant's discount:
`OrderProcessor` sets the current tenant on an `ITenantContext`, then
`PricingService` reads that context and the shared `ITenantDiscountStore` to
compute the net total.

## The bug (captive dependency + wrong lifetime)

Two coordinated defects break per-tenant pricing under any realistic use:

1. **`src/OrderService/OrderProcessor.cs`** — `OrderProcessor` is a singleton
   but injects the *scoped* `PricingService` and `ITenantContext` directly into
   its constructor. A singleton that captures scoped services holds one instance
   for the whole process lifetime (a "captive dependency"): the tenant assigned
   by one call is never reset, so state bleeds into later calls.
2. **`src/OrderService/ServiceCollectionExtensions.cs`** — `ITenantContext`
   carries per-request state but is registered as `AddSingleton`. It must be
   `AddScoped` so each request/scope gets its own tenant context.

`TenantContext` enforces single-assignment per scope, so the reused instance
throws `tenant already assigned` on the second tenant — the bug is deterministic,
not a rare race.

### Fix outline

- Register `ITenantContext` as `AddScoped` (fixes file 2).
- Make `OrderProcessor` depend on `IServiceScopeFactory` and open a fresh scope
  per `ProcessOrder` call, resolving `PricingService`/`ITenantContext` from that
  scope (fixes file 1). Keep `OrderProcessor` a singleton and keep its public
  `ProcessOrder(string, int)` signature unchanged.

The correct-lifetime table lives in the header comment of
`ServiceCollectionExtensions.cs`.

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
