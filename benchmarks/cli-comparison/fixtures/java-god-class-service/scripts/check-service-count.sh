#!/usr/bin/env bash
# Fixture-specific structural oracle for the required responsibility split.
set -euo pipefail

python3 - <<'PY'
import re
import sys
from pathlib import Path

service_dir = Path("src/main/java/com/example/service")
order_path = service_dir / "OrderService.java"

if not order_path.is_file():
    print("[SERVICE_COUNT] missing OrderService.java", file=sys.stderr)
    raise SystemExit(31)


def clean_java(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//.*$", "", text, flags=re.M)


def method_body(src: str, method: str, visibility: str = "public") -> str | None:
    match = re.search(
        rf"\b{visibility}\s+\S+(?:\s*<[^>]+>)?\s+{re.escape(method)}\s*\([^)]*\)\s*\{{",
        src,
    )
    if not match:
        return None
    depth = 1
    pos = match.end()
    while pos < len(src) and depth:
        if src[pos] == "{":
            depth += 1
        elif src[pos] == "}":
            depth -= 1
        pos += 1
    return src[match.end():pos - 1] if depth == 0 else None


def reachable_behavior(src: str, root_body: str) -> str:
    bodies = [root_body]
    pending = [root_body]
    seen: set[str] = set()
    keywords = {"if", "for", "while", "switch", "catch", "return", "throw", "new"}
    while pending:
        body = pending.pop()
        for helper in re.findall(r"(?<![\w.])(?:this\.)?([A-Za-z_]\w*)\s*\(", body):
            if helper in keywords or helper in seen:
                continue
            seen.add(helper)
            helper_body = method_body(src, helper, "private")
            if helper_body is not None:
                bodies.append(helper_body)
                pending.append(helper_body)
    return "\n".join(bodies)


contracts = {
    "InventoryService": "reserveInventory",
    "PaymentService": "processPayment",
    "NotificationService": "sendOrderNotification",
}
order_src = clean_java(order_path.read_text(encoding="utf-8"))
fields: dict[str, str] = {}

for class_name, method_name in contracts.items():
    service_path = service_dir / f"{class_name}.java"
    if not service_path.is_file():
        print(f"[SERVICE_COUNT] missing required {class_name}.java", file=sys.stderr)
        raise SystemExit(31)
    service_src = clean_java(service_path.read_text(encoding="utf-8"))
    if not re.search(rf"\bclass\s+{class_name}\b", service_src):
        print(f"[SERVICE_COUNT] {service_path} does not declare {class_name}", file=sys.stderr)
        raise SystemExit(31)
    if not re.search(rf"\bpublic\s+\S+(?:\s*<[^>]+>)?\s+{method_name}\s*\(", service_src):
        print(
            f"[SERVICE_COUNT] {class_name} must own public {method_name}(...) behavior",
            file=sys.stderr,
        )
        raise SystemExit(31)
    service_body = method_body(service_src, method_name)
    behavior = reachable_behavior(service_src, service_body or "")
    if (
        service_body is None
        or not re.search(r"\bthrow\b", behavior)
        or not re.search(
            r"\.(?:put|compute(?:IfAbsent|IfPresent)?|merge|replace|add|set|save|record|reserve|charge|send)\s*\(",
            behavior,
        )
    ):
        print(
            f"[SERVICE_COUNT] {class_name}.{method_name} must contain validation and state mutation",
            file=sys.stderr,
        )
        raise SystemExit(31)
    substantive = [
        line.strip()
        for line in service_src.splitlines()
        if line.strip()
        and line.strip() not in {"{", "}", "};"}
        and not line.strip().startswith(("package ", "import "))
    ]
    if len(substantive) < 8:
        print(f"[SERVICE_COUNT] {class_name} is too thin", file=sys.stderr)
        raise SystemExit(31)

    field = re.search(
        rf"\bprivate\s+final\s+{class_name}\s+([A-Za-z_]\w*)\s*;",
        order_src,
    )
    if not field:
        print(
            f"[SERVICE_COUNT] OrderService must hold final {class_name}",
            file=sys.stderr,
        )
        raise SystemExit(31)
    fields[class_name] = field.group(1)

constructors = re.findall(r"\bpublic\s+OrderService\s*\(([^)]*)\)", order_src, re.S)
if not any(all(class_name in params for class_name in contracts) for params in constructors):
    print(
        "[SERVICE_COUNT] OrderService needs a constructor injecting all three collaborators",
        file=sys.stderr,
    )
    raise SystemExit(31)

for class_name, method_name in contracts.items():
    field = fields[class_name]
    if not re.search(rf"\bthis\.{re.escape(field)}\s*=", order_src):
        print(f"[SERVICE_COUNT] injected {field} is not assigned", file=sys.stderr)
        raise SystemExit(31)
    body = method_body(order_src, method_name)
    if body is None or not re.fullmatch(
        rf"\s*(?:this\.)?{re.escape(field)}\.{method_name}\s*\([^;]+\)\s*;\s*",
        body,
    ):
        print(
            f"[SERVICE_COUNT] OrderService.{method_name} must delegate to {field}",
            file=sys.stderr,
        )
        raise SystemExit(31)

for method_name, retained_state in {
    "reserveInventory": "stock",
    "processPayment": "payments",
    "sendOrderNotification": "notifications",
}.items():
    body = method_body(order_src, method_name) or ""
    if re.search(rf"\b{retained_state}\b", body):
        print(
            f"[SERVICE_COUNT] OrderService.{method_name} retains {retained_state} responsibility",
            file=sys.stderr,
        )
        raise SystemExit(31)

print("[OK] required services own and receive delegated responsibilities")
PY
