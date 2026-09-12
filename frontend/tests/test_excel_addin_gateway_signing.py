"""The Excel add-in's Gateway signing, pinned to the Python contract.

No harness runs VBA, so the add-in carries one fixed request — secret, user,
timestamp, method, path, body, and the digest and signature they produce — in a
marked block in ``GatewayClient.bas`` and in the standalone
``verify_gateway_signing.vbs``. This test derives those two values from
``arcrho_hosted_save_http_contract`` and fails if either copy drifts, the way
``log_retention.test.mjs`` pins the Electron host's copy of the retention rule.
"""

from __future__ import annotations

import hashlib
import re
import sys
import unittest
from pathlib import Path


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
if str(PYTHON_API_SRC) not in sys.path:
    sys.path.insert(0, str(PYTHON_API_SRC))

from arcrho_engine_calculation_contract import (
    ENGINE_CALCULATION_CONTRACT_VERSION,
    ENGINE_CALCULATION_CSV_FIELD,
    ENGINE_CALCULATION_FUNCTION,
    ENGINE_CALCULATION_OPERATION_FIELD,
    ENGINE_CALCULATION_PATH,
    OPERATION_DATASET_CSV,
    OPERATION_OPTIONS,
    OUTPUT_VARIANT_CANONICAL,
)
from arcrho_hosted_save_http_contract import (
    AUTH_SIGNATURE_HEADER,
    AUTH_TIMESTAMP_HEADER,
    AUTH_USER_HEADER,
    CAPABILITIES_PATH,
    HEALTH_PATH,
    sign_request,
)
from arcrho_workspace_read_contract import WORKSPACE_READ_PATH

GATEWAY_CLIENT_BAS = REPOSITORY_ROOT / "excel-addin" / "src_vba" / "GatewayClient.bas"
VERIFY_SCRIPT = REPOSITORY_ROOT / "excel-addin" / "tools" / "verify_gateway_signing.vbs"

BLOCK_START = "' --- begin gateway signing vector ---"
BLOCK_END = "' --- end gateway signing vector ---"
CONST_PATTERN = re.compile(
    r'^\s*(?:Public\s+|Private\s+)?Const\s+(\w+)(?:\s+As\s+String)?\s*=\s*"(.*)"\s*$'
)
ESCAPE_PATTERN = re.compile(r"\\u([0-9a-fA-F]{4})")


def read_source(path: Path) -> str:
    return path.read_text(encoding="ascii")


def read_constants(text: str) -> dict[str, str]:
    """Every ``Const NAME = "value"`` line, with VBA's doubled quotes undone."""

    found: dict[str, str] = {}
    for line in text.splitlines():
        match = CONST_PATTERN.match(line)
        if match:
            found[match.group(1)] = match.group(2).replace('""', '"')
    return found


def read_vector_block(text: str) -> dict[str, str]:
    start = text.index(BLOCK_START) + len(BLOCK_START)
    return read_constants(text[start : text.index(BLOCK_END, start)])


def unescape(value: str) -> str:
    return ESCAPE_PATTERN.sub(lambda match: chr(int(match.group(1), 16)), value)


class ExcelAddInGatewayVectorTests(unittest.TestCase):
    """The fixed request both add-in copies sign."""

    def setUp(self) -> None:
        self.bas = read_source(GATEWAY_CLIENT_BAS)
        self.vbs = read_source(VERIFY_SCRIPT)
        self.vector = read_vector_block(self.bas)

    def test_both_copies_carry_the_same_vector(self) -> None:
        self.assertEqual(self.vector, read_vector_block(self.vbs))
        self.assertEqual(
            set(self.vector),
            {
                "VECTOR_SECRET",
                "VECTOR_USER",
                "VECTOR_TIMESTAMP",
                "VECTOR_METHOD",
                "VECTOR_PATH",
                "VECTOR_BODY",
                "VECTOR_DIGEST",
                "VECTOR_SIGNATURE",
            },
        )

    def test_vector_body_carries_a_non_ascii_name(self) -> None:
        """The escape is what keeps a UTF-8 body honest in an ASCII source."""

        body = unescape(self.vector["VECTOR_BODY"])
        self.assertNotEqual(body, self.vector["VECTOR_BODY"])
        self.assertGreater(len(body.encode("utf-8")), len(body))

    def test_digest_and_signature_match_the_contract(self) -> None:
        body = unescape(self.vector["VECTOR_BODY"]).encode("utf-8")
        self.assertEqual(hashlib.sha256(body).hexdigest(), self.vector["VECTOR_DIGEST"])
        self.assertEqual(
            sign_request(
                self.vector["VECTOR_SECRET"],
                user=self.vector["VECTOR_USER"],
                timestamp=self.vector["VECTOR_TIMESTAMP"],
                method=self.vector["VECTOR_METHOD"],
                path=self.vector["VECTOR_PATH"],
                body=body,
            ),
            self.vector["VECTOR_SIGNATURE"],
        )


class ExcelAddInGatewayConstantTests(unittest.TestCase):
    """The server-owned names the add-in has to spell out for itself."""

    def setUp(self) -> None:
        self.constants = read_constants(read_source(GATEWAY_CLIENT_BAS))

    def test_routes_match_the_contract(self) -> None:
        self.assertEqual(self.constants["GATEWAY_HEALTH_PATH"], HEALTH_PATH)
        self.assertEqual(self.constants["GATEWAY_CAPABILITIES_PATH"], CAPABILITIES_PATH)
        self.assertEqual(
            self.constants["GATEWAY_WORKSPACE_READ_PATH"], WORKSPACE_READ_PATH
        )
        self.assertEqual(
            self.constants["GATEWAY_ENGINE_CALCULATION_PATH"], ENGINE_CALCULATION_PATH
        )
        self.assertEqual(
            self.constants["GATEWAY_OPERATIONS_FIELD"], ENGINE_CALCULATION_OPERATION_FIELD
        )

    def test_headers_match_the_contract(self) -> None:
        self.assertEqual(self.constants["HEADER_USER"], AUTH_USER_HEADER)
        self.assertEqual(self.constants["HEADER_TIMESTAMP"], AUTH_TIMESTAMP_HEADER)
        self.assertEqual(self.constants["HEADER_SIGNATURE"], AUTH_SIGNATURE_HEADER)

    def test_calculation_request_names_match_the_contract(self) -> None:
        """What the add-in has to write into the request body and read back out."""

        self.assertEqual(
            self.constants["GATEWAY_CALCULATION_FUNCTION"], ENGINE_CALCULATION_FUNCTION
        )
        self.assertEqual(
            self.constants["GATEWAY_CONTRACT_VERSION"],
            str(ENGINE_CALCULATION_CONTRACT_VERSION),
        )
        self.assertEqual(
            self.constants["GATEWAY_OPERATION_DATASET_CSV"], OPERATION_DATASET_CSV
        )
        self.assertEqual(self.constants["GATEWAY_OUTPUT_VARIANT"], OUTPUT_VARIANT_CANONICAL)
        self.assertEqual(self.constants["GATEWAY_CSV_FIELD"], ENGINE_CALCULATION_CSV_FIELD)

    def test_the_only_option_the_add_in_sends_is_accepted(self) -> None:
        self.assertIn(
            self.constants["GATEWAY_FORCE_REFRESH_OPTION"],
            OPERATION_OPTIONS[OPERATION_DATASET_CSV],
        )


if __name__ == "__main__":
    unittest.main()
