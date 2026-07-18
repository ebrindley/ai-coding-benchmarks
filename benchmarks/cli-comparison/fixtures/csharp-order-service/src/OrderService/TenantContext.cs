namespace Example.OrderService;

/// <summary>
/// Default <see cref="ITenantContext"/>. Intended to be registered with a
/// <c>Scoped</c> lifetime: one instance per request/scope, serving one tenant.
/// The single-assignment invariant is what surfaces a reused-scope bug: if the
/// same instance is shared across tenants, the second assignment throws.
/// </summary>
public sealed class TenantContext : ITenantContext
{
    private string? _tenantId;

    public string TenantId
    {
        get => _tenantId ?? throw new InvalidOperationException("tenant has not been assigned for this scope");
        set
        {
            if (_tenantId is not null)
            {
                throw new InvalidOperationException("tenant already assigned for this scope");
            }

            _tenantId = value;
        }
    }
}
