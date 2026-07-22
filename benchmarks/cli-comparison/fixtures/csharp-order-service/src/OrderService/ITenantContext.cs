namespace Example.OrderService;

/// <summary>
/// Per-request tenant context. Exactly one tenant is served within a single
/// dependency-injection scope, so <see cref="TenantId"/> may only be assigned once.
/// </summary>
public interface ITenantContext
{
    /// <summary>
    /// The tenant this scope is serving. Throws if read before assignment or
    /// assigned more than once within the same scope.
    /// </summary>
    string TenantId { get; set; }
}
