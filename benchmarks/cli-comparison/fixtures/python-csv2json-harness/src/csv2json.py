from __future__ import annotations

import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="csv2json", description="Convert CSV to JSON")
    parser.add_argument("csv_path", help="Path to CSV file")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    return parser


def main(argv: list[str] | None = None) -> int:
    _ = build_parser().parse_args(argv)
    raise NotImplementedError("Implement CSV→JSON conversion per task spec")


if __name__ == "__main__":
    raise SystemExit(main())
