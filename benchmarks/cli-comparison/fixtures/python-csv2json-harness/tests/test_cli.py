from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "src" / "csv2json.py"


def run_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        cwd=PROJECT_ROOT,
        text=True,
        capture_output=True,
    )


def test_help_flag(tmp_path: Path) -> None:
    result = run_cli(["--help"])
    assert result.returncode == 0
    assert "usage" in (result.stdout + result.stderr).lower()


def test_basic_conversion(tmp_path: Path) -> None:
    csv_path = tmp_path / "data.csv"
    csv_path.write_text("name,age\nalice,30\nbob,25\n", encoding="utf-8")

    result = run_cli([str(csv_path)])
    assert result.returncode == 0

    payload = json.loads(result.stdout)
    assert payload == [{"name": "alice", "age": "30"}, {"name": "bob", "age": "25"}]


def test_headers_as_keys(tmp_path: Path) -> None:
    csv_path = tmp_path / "data.csv"
    csv_path.write_text("col1,col2\nx,y\n", encoding="utf-8")

    result = run_cli([str(csv_path)])
    assert result.returncode == 0

    payload = json.loads(result.stdout)
    assert payload == [{"col1": "x", "col2": "y"}]


def test_missing_file_error(tmp_path: Path) -> None:
    result = run_cli([str(tmp_path / "missing.csv")])
    assert result.returncode == 1
    assert "not found" in result.stderr.lower()


def test_malformed_csv(tmp_path: Path) -> None:
    csv_path = tmp_path / "data.csv"
    csv_path.write_text("a,b\n1,2,3\n", encoding="utf-8")

    result = run_cli([str(csv_path)])
    assert result.returncode == 1
    assert "malformed" in result.stderr.lower()


def test_pretty_flag(tmp_path: Path) -> None:
    csv_path = tmp_path / "data.csv"
    csv_path.write_text("name,age\nalice,30\n", encoding="utf-8")

    result = run_cli([str(csv_path), "--pretty"])
    assert result.returncode == 0
    assert "\n" in result.stdout
