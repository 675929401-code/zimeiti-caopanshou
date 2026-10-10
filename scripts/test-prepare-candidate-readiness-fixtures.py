#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
HELPER_PATH = SCRIPT_DIRECTORY / "prepare-candidate-readiness-fixtures.py"
PROVISIONER_PATH = SCRIPT_DIRECTORY / "provision-production-runtime-safety.sh"
SPEC = importlib.util.spec_from_file_location("candidate_fixture_helper", HELPER_PATH)
assert SPEC and SPEC.loader
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def seed_voice_database(
    path: Path,
    *,
    include_clone_license: bool = True,
    include_voice_category: bool = True,
    voice_category_type: str = "TEXT",
) -> None:
    database = sqlite3.connect(path)
    try:
        category_column = f",category {voice_category_type}" if include_voice_category else ""
        clone_license_table = (
            "CREATE TABLE CloneLicense(id TEXT PRIMARY KEY,licenseKey TEXT UNIQUE,status TEXT,assignedTo TEXT,"
            "speakerId TEXT,maxTrainings INTEGER,usedTrainings INTEGER,createdAt DATETIME,usedAt DATETIME,"
            "updatedAt DATETIME);"
            if include_clone_license
            else ""
        )
        schema_sql = (
            "PRAGMA journal_mode=WAL;"
            "CREATE TABLE User(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT,role TEXT,"
            "balance REAL,storageConfigured BOOLEAN,createdAt DATETIME,updatedAt DATETIME);"
            "CREATE TABLE Voice(id TEXT PRIMARY KEY,speakerId TEXT UNIQUE,name TEXT,description TEXT,type TEXT"
            f"{category_column},tags TEXT,language TEXT,gender TEXT,avatar TEXT,isActive BOOLEAN,isRecommended BOOLEAN,"
            "userId TEXT,createdAt DATETIME,updatedAt DATETIME);"
            "CREATE TABLE Favorite(id TEXT PRIMARY KEY,userId TEXT,voiceId TEXT,createdAt DATETIME,"
            "UNIQUE(userId,voiceId));"
            "CREATE TABLE TTSJob(id TEXT PRIMARY KEY,userId TEXT,voiceId TEXT,text TEXT,model TEXT,mode TEXT,"
            "params TEXT,status TEXT,audioUrl TEXT,duration REAL,tokensUsed INTEGER,charCount INTEGER,cost REAL,"
            "error TEXT,createdAt DATETIME,completedAt DATETIME);"
            "CREATE TABLE ApiConfig(id TEXT PRIMARY KEY,name TEXT,apiKey TEXT,resourceId TEXT,costPricePer1k REAL,"
            "profitMargin REAL,isActive BOOLEAN,createdAt DATETIME,updatedAt DATETIME);"
            "CREATE TABLE ModelConfig(id TEXT PRIMARY KEY,name TEXT,modelId TEXT UNIQUE,resourceId TEXT,apiKey TEXT,"
            "totalPrice REAL,totalChars INTEGER,costPrice REAL,unit TEXT,profitMargin REAL,isActive BOOLEAN,"
            "sort INTEGER,createdAt DATETIME,updatedAt DATETIME);"
            "CREATE TABLE \"Transaction\"(id TEXT PRIMARY KEY,userId TEXT,type TEXT,amount REAL,balance REAL,"
            "description TEXT,jobId TEXT,createdAt DATETIME);"
            f"{clone_license_table}"
            "CREATE TABLE Audit(id INTEGER PRIMARY KEY,payload TEXT);"
            "CREATE INDEX VoiceSpeaker ON Voice(speakerId);"
            "CREATE TRIGGER VoiceAudit AFTER INSERT ON Voice BEGIN "
            "INSERT INTO Audit(payload) VALUES (NEW.speakerId); END;"
        )
        voice_row_sql = (
            "INSERT INTO Voice(id,speakerId,name,category,userId) VALUES "
            "('voice-1','private-speaker','Private','private-category','user-1');"
            if include_voice_category
            else "INSERT INTO Voice(id,speakerId,name,userId) VALUES "
            "('voice-1','private-speaker','Private','user-1');"
        )
        database.executescript(
            schema_sql
            + "INSERT INTO User(id,email,password) VALUES ('user-1','private@example.invalid','private-password');"
            + voice_row_sql
            + "INSERT INTO ModelConfig(id,name,modelId,apiKey) VALUES "
            "('model-1','Private','private-model','private-api-secret');"
            "ANALYZE;"
        )
        database.commit()
    finally:
        database.close()


class CandidateFixtureTests(unittest.TestCase):
    def make_root(self, raw_root: str) -> Path:
        root = Path(raw_root).resolve()
        os.chmod(root, 0o700)
        return root

    def test_self_test_and_argument_contract(self) -> None:
        result = subprocess.run(
            [sys.executable, str(HELPER_PATH), "--self-test"],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("production records copied=0", result.stdout)
        invalid = subprocess.run(
            [
                sys.executable,
                str(HELPER_PATH),
                "--service",
                "web",
                "--input-root",
                str(SCRIPT_DIRECTORY),
                "--input",
                str(HELPER_PATH),
                "--output-root",
                str(SCRIPT_DIRECTORY),
                "--output",
                str(SCRIPT_DIRECTORY / "forbidden-output"),
            ],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("requires --voice-output", invalid.stderr)

    def test_web_fixture_is_empty_valid_and_contains_no_forbidden_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="candidate-web-test-") as raw_root:
            root = self.make_root(raw_root)
            source = root / "production.db"
            seed_voice_database(source)
            output = root / "web"
            voice_output = root / "voice.db"
            _, checked_output = helper.validate_output(str(root), str(output))
            _, checked_voice_output = helper.validate_output(str(root), str(voice_output))
            receipt = helper.create_web_service_fixture(source, checked_output, checked_voice_output)
            self.assertEqual(receipt["productionRecordsCopied"], 0)
            self.assertEqual(receipt["records"], 0)
            self.assertEqual(receipt["fileCount"], 7)
            self.assertEqual(receipt["quickCheck"], "ok")
            found = set()
            serialized = bytearray()
            for file_path in output.rglob("*.json"):
                relative = file_path.relative_to(output).as_posix()
                found.add(relative)
                value = json.loads(file_path.read_text(encoding="utf-8"))
                self.assertEqual(value, helper.WEB_FIXTURES[relative])
                serialized.extend(file_path.read_bytes())
                if os.name == "posix":
                    self.assertEqual(stat.S_IMODE(file_path.stat().st_mode), 0o600)
            self.assertEqual(found, set(helper.WEB_FIXTURES))
            lowered = bytes(serialized).lower()
            for forbidden in helper.FORBIDDEN_CONFIG_KEYS:
                self.assertNotIn(forbidden.encode("ascii"), lowered)
            with self.assertRaises(helper.BlockedError):
                helper.validate_output(str(root), str(root.parent / "escaped"))
            with self.assertRaises(helper.BlockedError):
                helper.validate_output(str(root), str(output))
            candidate = sqlite3.connect(f"file:{voice_output.as_posix()}?mode=ro", uri=True)
            try:
                self.assertEqual(candidate.execute("PRAGMA quick_check").fetchone()[0], "ok")
                self.assertEqual(candidate.execute("PRAGMA freelist_count").fetchone()[0], 0)
                self.assertEqual(candidate.execute("SELECT COUNT(*) FROM Voice").fetchone()[0], 0)
                self.assertEqual(candidate.execute("SELECT COUNT(*) FROM User").fetchone()[0], 0)
                self.assertEqual(candidate.execute("SELECT COUNT(*) FROM ModelConfig").fetchone()[0], 0)
            finally:
                candidate.close()
            for secret in (b"private@example.invalid", b"private-password", b"private-speaker", b"private-api-secret"):
                self.assertNotIn(secret, voice_output.read_bytes())

    def test_web_and_voice_cli_generate_only_inside_the_allowed_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="candidate-cli-test-") as raw_root:
            root = self.make_root(raw_root)
            source = root / "production.db"
            seed_voice_database(source)
            web_data = root / "web-data"
            web_voice = root / "web-voice.db"
            web = subprocess.run(
                [
                    sys.executable,
                    str(HELPER_PATH),
                    "--service",
                    "web",
                    "--input-root",
                    str(root),
                    "--input",
                    str(source),
                    "--output-root",
                    str(root),
                    "--output",
                    str(web_data),
                    "--voice-output",
                    str(web_voice),
                ],
                check=False,
                text=True,
                capture_output=True,
            )
            self.assertEqual(web.returncode, 0, web.stderr)
            self.assertEqual(json.loads(web.stdout)["productionRecordsCopied"], 0)
            self.assertTrue((web_data / "studio-config.json").is_file())
            self.assertTrue(web_voice.is_file())

            voice_output = root / "voice-only.db"
            voice = subprocess.run(
                [
                    sys.executable,
                    str(HELPER_PATH),
                    "--service",
                    "voice",
                    "--input-root",
                    str(root),
                    "--input",
                    str(source),
                    "--output-root",
                    str(root),
                    "--output",
                    str(voice_output),
                ],
                check=False,
                text=True,
                capture_output=True,
            )
            self.assertEqual(voice.returncode, 0, voice.stderr)
            self.assertEqual(json.loads(voice.stdout)["quickCheck"], "ok")
            self.assertTrue(voice_output.is_file())

    def test_voice_fixture_preserves_schema_and_copies_zero_records_or_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="candidate-voice-test-") as raw_root:
            root = self.make_root(raw_root)
            source = root / "production.db"
            output = root / "candidate.db"
            seed_voice_database(source)
            source_hash = sha256(source)
            source_path = helper.validate_input(str(root), str(source))
            _, output_path = helper.validate_output(str(root), str(output))
            receipt = helper.create_voice_fixture(source_path, output_path)
            self.assertEqual(receipt["productionRecordsCopied"], 0)
            self.assertEqual(receipt["records"], 0)
            self.assertEqual(receipt["quickCheck"], "ok")
            self.assertEqual(receipt["schemaContractVersion"], helper.VOICE_SCHEMA_CONTRACT_VERSION)
            self.assertRegex(receipt["schemaContractSha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(receipt["sourceSchemaSha256"], receipt["outputSchemaSha256"])
            self.assertEqual(sha256(source), source_hash)
            candidate = sqlite3.connect(f"file:{output.as_posix()}?mode=ro", uri=True)
            try:
                self.assertEqual(candidate.execute("PRAGMA quick_check").fetchone()[0], "ok")
                tables = helper.table_names(candidate)
                self.assertTrue(set(helper.VOICE_SCHEMA_CONTRACT).issubset(tables))
                for table in tables:
                    count = candidate.execute(
                        f"SELECT COUNT(*) FROM {helper.quote_identifier(table)}"
                    ).fetchone()[0]
                    self.assertEqual(count, 0, table)
                trigger_count = candidate.execute(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND name='VoiceAudit'"
                ).fetchone()[0]
                self.assertEqual(trigger_count, 1)
                if candidate.execute(
                    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_stat1'"
                ).fetchone():
                    self.assertEqual(candidate.execute("SELECT COUNT(*) FROM sqlite_stat1").fetchone()[0], 0)
            finally:
                candidate.close()
            candidate_bytes = output.read_bytes()
            for secret in (
                b"private@example.invalid",
                b"private-password",
                b"private-speaker",
                b"private-api-secret",
            ):
                self.assertNotIn(secret, candidate_bytes)
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

    def test_voice_schema_contract_rejects_missing_table_column_and_incompatible_affinity(self) -> None:
        scenarios = (
            ("missing-table", {"include_clone_license": False}, "missing required Voice tables"),
            ("missing-column", {"include_voice_category": False}, "missing required columns: category"),
            ("incompatible-affinity", {"voice_category_type": "INTEGER"}, "schema-incompatible"),
        )
        for scenario, seed_options, expected_error in scenarios:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(
                prefix=f"candidate-schema-{scenario}-"
            ) as raw_root:
                root = self.make_root(raw_root)
                source = root / "production.db"
                output = root / "candidate.db"
                seed_voice_database(source, **seed_options)
                source_path = helper.validate_input(str(root), str(source))
                _, output_path = helper.validate_output(str(root), str(output))
                with self.assertRaisesRegex(helper.BlockedError, expected_error):
                    helper.create_voice_fixture(source_path, output_path)
                self.assertFalse(output.exists(), "a schema-incompatible fixture must never be published")

    def test_symlink_inputs_and_output_roots_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="candidate-link-test-") as raw_root:
            root = self.make_root(raw_root)
            source = root / "production.db"
            seed_voice_database(source)
            source_link = root / "source-link.db"
            root_link = root.parent / f"{root.name}-link"
            try:
                source_link.symlink_to(source)
                root_link.symlink_to(root, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable in this test environment")
            try:
                with self.assertRaises(helper.BlockedError):
                    helper.validate_input(str(root), str(source_link))
                with self.assertRaises(helper.BlockedError):
                    helper.validate_output(str(root_link), str(root_link / "candidate.db"))
            finally:
                root_link.unlink(missing_ok=True)

    def test_provisioner_pins_helper_and_candidate_identity_guards(self) -> None:
        source = PROVISIONER_PATH.read_text(encoding="utf-8")
        match = re.search(r'^FIXTURE_SHA256="([0-9a-f]{64})"$', source, re.MULTILINE)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), sha256(HELPER_PATH))
        self.assertIn('FIXTURE_TARGET="/usr/local/libexec/zimeiti/prepare-candidate-readiness-fixtures.py"', source)
        self.assertIn('atomic_install_reviewed_file "$FIXTURE_SOURCE" "$FIXTURE_TARGET" 755', source)
        self.assertIn('"$FIXTURE_TARGET" --self-test', source)
        self.assertIn('CANDIDATE_ACTIVE_PROCESS_COUNT=', source)
        self.assertIn('candidate user belongs to supplementary groups', source)
        self.assertIn('candidate account is not reported locked', source)
        self.assertIn('candidate no-home path unexpectedly exists', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
