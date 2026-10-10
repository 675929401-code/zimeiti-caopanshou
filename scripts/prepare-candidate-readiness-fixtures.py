#!/usr/bin/env python3
"""Create empty, non-production candidate readiness fixtures.

The helper is installed as a pinned root-owned executable.  It never copies
production JSON.  For Voice it uses sqlite3's online backup API to obtain a
consistent schema snapshot in memory, removes every user-table row, vacuums
the in-memory database, and only then writes a new candidate database.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tempfile
from typing import Any
from contextlib import closing


INSTALLED_PATH = Path("/usr/local/libexec/zimeiti/prepare-candidate-readiness-fixtures.py")
FORBIDDEN_CONFIG_KEYS = {"apikey", "userid", "username", "filekey", "sourceinfo"}
WEB_FIXTURES: dict[str, Any] = {
    "engine-configs.json": [],
    "custom-voices.json": [],
    "service-cards.json": [],
    "studio-config.json": {},
    "voices.json": [],
    "voice-studio/service-cards.json": [],
    "voice-studio/voices.json": [],
}
VOICE_SCHEMA_CONTRACT_VERSION = "zimeiti-voice-sqlite-readiness.v1"
# This is a compatibility contract, not a copy of production data. Extra
# columns/tables are allowed, but every field Prisma reads must retain a
# compatible SQLite affinity. The full source schema is separately bound by a
# canonical SHA-256 so the redacted output cannot silently drift from it.
VOICE_SCHEMA_CONTRACT: dict[str, dict[str, tuple[tuple[str, ...], bool]]] = {
    "User": {
        "id": (("TEXT",), True),
        "email": (("TEXT",), False),
        "name": (("TEXT",), False),
        "password": (("TEXT",), False),
        "role": (("TEXT",), False),
        "balance": (("REAL",), False),
        "storageConfigured": (("NUMERIC", "INTEGER"), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
        "updatedAt": (("NUMERIC", "TEXT"), False),
    },
    "Voice": {
        "id": (("TEXT",), True),
        "speakerId": (("TEXT",), False),
        "name": (("TEXT",), False),
        "description": (("TEXT",), False),
        "type": (("TEXT",), False),
        "category": (("TEXT",), False),
        "tags": (("TEXT",), False),
        "language": (("TEXT",), False),
        "gender": (("TEXT",), False),
        "avatar": (("TEXT",), False),
        "isActive": (("NUMERIC", "INTEGER"), False),
        "isRecommended": (("NUMERIC", "INTEGER"), False),
        "userId": (("TEXT",), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
        "updatedAt": (("NUMERIC", "TEXT"), False),
    },
    "Favorite": {
        "id": (("TEXT",), True),
        "userId": (("TEXT",), False),
        "voiceId": (("TEXT",), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
    },
    "TTSJob": {
        "id": (("TEXT",), True),
        "userId": (("TEXT",), False),
        "voiceId": (("TEXT",), False),
        "text": (("TEXT",), False),
        "model": (("TEXT",), False),
        "mode": (("TEXT",), False),
        "params": (("TEXT",), False),
        "status": (("TEXT",), False),
        "audioUrl": (("TEXT",), False),
        "duration": (("REAL",), False),
        "tokensUsed": (("INTEGER",), False),
        "charCount": (("INTEGER",), False),
        "cost": (("REAL",), False),
        "error": (("TEXT",), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
        "completedAt": (("NUMERIC", "TEXT"), False),
    },
    "ApiConfig": {
        "id": (("TEXT",), True),
        "name": (("TEXT",), False),
        "apiKey": (("TEXT",), False),
        "resourceId": (("TEXT",), False),
        "costPricePer1k": (("REAL",), False),
        "profitMargin": (("REAL",), False),
        "isActive": (("NUMERIC", "INTEGER"), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
        "updatedAt": (("NUMERIC", "TEXT"), False),
    },
    "ModelConfig": {
        "id": (("TEXT",), True),
        "name": (("TEXT",), False),
        "modelId": (("TEXT",), False),
        "resourceId": (("TEXT",), False),
        "apiKey": (("TEXT",), False),
        "totalPrice": (("REAL",), False),
        "totalChars": (("INTEGER",), False),
        "costPrice": (("REAL",), False),
        "unit": (("TEXT",), False),
        "profitMargin": (("REAL",), False),
        "isActive": (("NUMERIC", "INTEGER"), False),
        "sort": (("INTEGER",), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
        "updatedAt": (("NUMERIC", "TEXT"), False),
    },
    "Transaction": {
        "id": (("TEXT",), True),
        "userId": (("TEXT",), False),
        "type": (("TEXT",), False),
        "amount": (("REAL",), False),
        "balance": (("REAL",), False),
        "description": (("TEXT",), False),
        "jobId": (("TEXT",), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
    },
    "CloneLicense": {
        "id": (("TEXT",), True),
        "licenseKey": (("TEXT",), False),
        "status": (("TEXT",), False),
        "assignedTo": (("TEXT",), False),
        "speakerId": (("TEXT",), False),
        "maxTrainings": (("INTEGER",), False),
        "usedTrainings": (("INTEGER",), False),
        "createdAt": (("NUMERIC", "TEXT"), False),
        "usedAt": (("NUMERIC", "TEXT"), False),
        "updatedAt": (("NUMERIC", "TEXT"), False),
    },
}
REQUIRED_UNIQUE_COLUMN_SETS: dict[str, tuple[tuple[str, ...], ...]] = {
    "User": (("email",),),
    "Voice": (("speakerId",),),
    "Favorite": (("userId", "voiceId"),),
    "ModelConfig": (("modelId",),),
    "CloneLicense": (("licenseKey",),),
}
MAX_SOURCE_DATABASE_BYTES = 1024 * 1024 * 1024


class BlockedError(RuntimeError):
    """A fail-closed input, path, or data-contract rejection."""


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def require_normal_absolute(raw: str, label: str) -> Path:
    if not raw or "\x00" in raw:
        raise BlockedError(f"{label} is empty or contains NUL")
    path = Path(raw)
    if not path.is_absolute():
        raise BlockedError(f"{label} must be absolute")
    if os.path.normpath(raw) != raw:
        raise BlockedError(f"{label} must be lexically normalized")
    return path


def assert_no_symlink_components(path: Path, label: str, *, allow_missing_leaf: bool = False) -> None:
    parts = path.parts
    if not parts:
        raise BlockedError(f"{label} has no path components")
    current = Path(parts[0])
    for index, part in enumerate(parts[1:], start=1):
        current /= part
        is_leaf = index == len(parts) - 1
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if allow_missing_leaf and is_leaf:
                return
            raise BlockedError(f"{label} has a missing path component: {current}") from None
        if stat.S_ISLNK(metadata.st_mode):
            raise BlockedError(f"{label} traverses a symbolic link: {current}")


def require_directory(path: Path, label: str) -> os.stat_result:
    assert_no_symlink_components(path, label)
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise BlockedError(f"{label} must be a real directory")
    if path.resolve(strict=True) != path:
        raise BlockedError(f"{label} must be canonical")
    return metadata


def require_regular_file(path: Path, label: str) -> os.stat_result:
    assert_no_symlink_components(path, label)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise BlockedError(f"{label} must be a single-link regular file")
    if path.resolve(strict=True) != path:
        raise BlockedError(f"{label} must be canonical")
    return metadata


def require_beneath(root: Path, path: Path, label: str, *, allow_equal: bool = False) -> None:
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise BlockedError(f"{label} escapes its allowed root") from None
    if not allow_equal and not relative.parts:
        raise BlockedError(f"{label} must be below, not equal to, its allowed root")


def validate_output(output_root_raw: str, output_raw: str) -> tuple[Path, Path]:
    output_root = require_normal_absolute(output_root_raw, "output root")
    output = require_normal_absolute(output_raw, "output")
    root_metadata = require_directory(output_root, "output root")
    if os.name == "posix" and (root_metadata.st_mode & 0o022):
        raise BlockedError("output root must not be group/other writable")
    require_beneath(output_root, output, "output")
    require_directory(output.parent, "output parent")
    assert_no_symlink_components(output, "output", allow_missing_leaf=True)
    if output.exists() or output.is_symlink():
        raise BlockedError("output must not already exist")
    return output_root, output


def validate_input(input_root_raw: str, input_raw: str) -> Path:
    input_root = require_normal_absolute(input_root_raw, "input root")
    input_path = require_normal_absolute(input_raw, "input")
    require_directory(input_root, "input root")
    require_beneath(input_root, input_path, "input")
    metadata = require_regular_file(input_path, "input")
    if metadata.st_size <= 0 or metadata.st_size > MAX_SOURCE_DATABASE_BYTES:
        raise BlockedError("input database is empty or exceeds the 1 GiB safety limit")
    return input_path


def fsync_directory(directory: Path) -> None:
    if os.name != "posix":
        return
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def rename_noreplace(source: Path, destination: Path) -> None:
    if os.name != "posix":
        if destination.exists() or destination.is_symlink():
            raise BlockedError("output appeared before atomic installation")
        os.rename(source, destination)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise BlockedError("renameat2 is required for exclusive atomic installation")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        -100,
        os.fsencode(source),
        -100,
        os.fsencode(destination),
        1,
    )
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.EEXIST:
        raise BlockedError("output appeared before atomic installation")
    raise BlockedError(f"exclusive atomic installation failed: errno={error_number}")


def atomic_write_bytes(path: Path, content: bytes, mode: int = 0o600) -> None:
    descriptor, raw_temp = tempfile.mkstemp(prefix=f".{path.name}.tmp.", dir=path.parent)
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, mode)
        require_regular_file(temp_path, "temporary output")
        rename_noreplace(temp_path, path)
        fsync_directory(path.parent)
    finally:
        if temp_path.exists() or temp_path.is_symlink():
            temp_path.unlink()


def assert_no_forbidden_config_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).casefold() in FORBIDDEN_CONFIG_KEYS:
                raise BlockedError("generated configuration contains a forbidden identity or secret field")
            assert_no_forbidden_config_keys(child)
    elif isinstance(value, list):
        for child in value:
            assert_no_forbidden_config_keys(child)


def create_web_fixture(output: Path) -> dict[str, Any]:
    temp_directory = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp.", dir=output.parent))
    try:
        os.chmod(temp_directory, 0o700)
        for relative_name, value in WEB_FIXTURES.items():
            assert_no_forbidden_config_keys(value)
            destination = temp_directory.joinpath(*relative_name.split("/"))
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(destination.parent, 0o700)
            content = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            atomic_write_bytes(destination, content)
        for relative_name, expected in WEB_FIXTURES.items():
            candidate = temp_directory.joinpath(*relative_name.split("/"))
            metadata = require_regular_file(candidate, "generated Web fixture")
            if os.name == "posix" and stat.S_IMODE(metadata.st_mode) != 0o600:
                raise BlockedError("generated Web fixture permissions are not 0600")
            actual = json.loads(candidate.read_text(encoding="utf-8"))
            if actual != expected:
                raise BlockedError("generated Web fixture failed schema readback")
            assert_no_forbidden_config_keys(actual)
        rename_noreplace(temp_directory, output)
        fsync_directory(output.parent)
        return {
            "schemaVersion": "zimeiti-candidate-fixture.v1",
            "status": "ready",
            "service": "web",
            "fileCount": len(WEB_FIXTURES),
            "records": 0,
            "productionRecordsCopied": 0,
        }
    finally:
        if temp_directory.exists():
            shutil.rmtree(temp_directory)


def sqlite_connect_read_only(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30.0)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def quick_check(connection: sqlite3.Connection, label: str) -> None:
    rows = [str(row[0]) for row in connection.execute("PRAGMA quick_check")]
    if rows != ["ok"]:
        raise BlockedError(f"{label} quick_check failed")


def table_names(connection: sqlite3.Connection) -> list[str]:
    return [
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_schema "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name"
        )
    ]


def sqlite_affinity(declared_type: str) -> str:
    normalized = declared_type.strip().upper()
    if "INT" in normalized:
        return "INTEGER"
    if any(marker in normalized for marker in ("CHAR", "CLOB", "TEXT")):
        return "TEXT"
    if not normalized or "BLOB" in normalized:
        return "BLOB"
    if any(marker in normalized for marker in ("REAL", "FLOA", "DOUB")):
        return "REAL"
    return "NUMERIC"


def canonical_schema(connection: sqlite3.Connection) -> list[dict[str, str]]:
    return [
        {"type": str(row[0]), "name": str(row[1]), "table": str(row[2]), "sql": str(row[3])}
        for row in connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema "
            "WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name, tbl_name"
        )
    ]


def sha256_json(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def schema_contract_sha256() -> str:
    serializable = {
        "version": VOICE_SCHEMA_CONTRACT_VERSION,
        "tables": VOICE_SCHEMA_CONTRACT,
        "uniqueColumnSets": REQUIRED_UNIQUE_COLUMN_SETS,
    }
    return sha256_json(serializable)


def unique_column_sets(connection: sqlite3.Connection, table: str) -> set[tuple[str, ...]]:
    result: set[tuple[str, ...]] = set()
    for index_row in connection.execute(f"PRAGMA index_list({quote_identifier(table)})"):
        if int(index_row[2]) != 1:
            continue
        index_name = str(index_row[1])
        columns = tuple(
            str(row[2])
            for row in connection.execute(f"PRAGMA index_info({quote_identifier(index_name)})")
            if row[2] is not None
        )
        if columns:
            result.add(columns)
    return result


def validate_voice_schema_contract(connection: sqlite3.Connection, label: str) -> dict[str, Any]:
    tables = set(table_names(connection))
    missing_tables = sorted(set(VOICE_SCHEMA_CONTRACT).difference(tables))
    if missing_tables:
        raise BlockedError(f"{label} is missing required Voice tables: {','.join(missing_tables)}")
    for table, required_columns in VOICE_SCHEMA_CONTRACT.items():
        actual_columns = {
            str(row[1]): {"affinity": sqlite_affinity(str(row[2])), "primaryKey": int(row[5]) > 0}
            for row in connection.execute(f"PRAGMA table_info({quote_identifier(table)})")
        }
        missing_columns = sorted(set(required_columns).difference(actual_columns))
        if missing_columns:
            raise BlockedError(f"{label} table {table} is missing required columns: {','.join(missing_columns)}")
        for column, (allowed_affinities, primary_key) in required_columns.items():
            actual = actual_columns[column]
            if actual["affinity"] not in allowed_affinities or (primary_key and not actual["primaryKey"]):
                raise BlockedError(
                    f"{label} table {table} column {column} is schema-incompatible "
                    f"(affinity={actual['affinity']}, primaryKey={actual['primaryKey']})"
                )
        actual_unique_sets = unique_column_sets(connection, table)
        for required_columns_tuple in REQUIRED_UNIQUE_COLUMN_SETS.get(table, ()):
            if required_columns_tuple not in actual_unique_sets:
                raise BlockedError(
                    f"{label} table {table} is missing required unique columns: {','.join(required_columns_tuple)}"
                )
    return {
        "tableCount": len(tables),
        "schemaSha256": sha256_json(canonical_schema(connection)),
        "schemaContractVersion": VOICE_SCHEMA_CONTRACT_VERSION,
        "schemaContractSha256": schema_contract_sha256(),
    }


def clear_snapshot(connection: sqlite3.Connection) -> int:
    tables = table_names(connection)
    validate_voice_schema_contract(connection, "candidate Voice snapshot")
    triggers = [
        (str(name), str(sql_text))
        for name, sql_text in connection.execute(
            "SELECT name, sql FROM sqlite_schema "
            "WHERE type='trigger' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name"
        )
    ]
    connection.execute("PRAGMA foreign_keys=OFF")
    connection.execute("BEGIN IMMEDIATE")
    try:
        for name, _ in triggers:
            connection.execute(f"DROP TRIGGER {quote_identifier(name)}")
        for name in tables:
            connection.execute(f"DELETE FROM {quote_identifier(name)}")
        internal_state_tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' "
                "AND (name='sqlite_sequence' OR name LIKE 'sqlite_stat%') ORDER BY name"
            )
        ]
        for name in internal_state_tables:
            connection.execute(f"DELETE FROM {quote_identifier(name)}")
        for _, sql_text in triggers:
            connection.execute(sql_text)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    for name in tables:
        count = int(connection.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0])
        if count != 0:
            raise BlockedError("candidate Voice fixture retained table records")
    connection.execute("VACUUM")
    if int(connection.execute("PRAGMA freelist_count").fetchone()[0]) != 0:
        raise BlockedError("candidate Voice fixture retains free pages after VACUUM")
    quick_check(connection, "in-memory candidate Voice fixture")
    return len(tables)


def create_voice_fixture(source: Path, output: Path) -> dict[str, Any]:
    source_before = source.stat()
    memory = sqlite3.connect(":memory:", timeout=30.0)
    try:
        with closing(sqlite_connect_read_only(source)) as production:
            quick_check(production, "input Voice database")
            source_schema = validate_voice_schema_contract(production, "input Voice database")
            production.backup(memory, pages=1024)
        source_after = source.stat()
        if (source_before.st_dev, source_before.st_ino) != (source_after.st_dev, source_after.st_ino):
            raise BlockedError("input Voice database identity changed during backup")
        copied_schema = validate_voice_schema_contract(memory, "backed-up Voice database")
        if copied_schema["schemaSha256"] != source_schema["schemaSha256"]:
            raise BlockedError("Voice schema changed while the consistent candidate snapshot was created")
        table_count = clear_snapshot(memory)
        cleared_schema = validate_voice_schema_contract(memory, "cleared candidate Voice fixture")
        if cleared_schema["schemaSha256"] != source_schema["schemaSha256"]:
            raise BlockedError("candidate Voice schema drifted while production records were removed")

        descriptor, raw_temp = tempfile.mkstemp(prefix=f".{output.name}.tmp.", dir=output.parent)
        os.close(descriptor)
        temp_path = Path(raw_temp)
        temp_path.unlink()
        try:
            destination = sqlite3.connect(temp_path)
            try:
                memory.backup(destination, pages=1024)
                destination.execute("PRAGMA journal_mode=DELETE")
                quick_check(destination, "written candidate Voice fixture")
                written_schema = validate_voice_schema_contract(destination, "written candidate Voice fixture")
                if written_schema["schemaSha256"] != source_schema["schemaSha256"]:
                    raise BlockedError("written candidate Voice fixture schema does not match its source snapshot")
                if int(destination.execute("PRAGMA freelist_count").fetchone()[0]) != 0:
                    raise BlockedError("written candidate Voice fixture retains free pages")
                for name in table_names(destination):
                    if int(destination.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0]) != 0:
                        raise BlockedError("written candidate Voice fixture retained table records")
                destination.commit()
            finally:
                destination.close()
            os.chmod(temp_path, 0o600)
            metadata = require_regular_file(temp_path, "temporary Voice fixture")
            if metadata.st_size <= 0:
                raise BlockedError("candidate Voice fixture is empty")
            descriptor = os.open(temp_path, os.O_RDWR)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            rename_noreplace(temp_path, output)
            fsync_directory(output.parent)
        finally:
            if temp_path.exists() or temp_path.is_symlink():
                temp_path.unlink()
    finally:
        memory.close()

    with closing(sqlite_connect_read_only(output)) as verification:
        quick_check(verification, "installed candidate Voice fixture")
        if int(verification.execute("PRAGMA freelist_count").fetchone()[0]) != 0:
            raise BlockedError("installed candidate Voice fixture retains free pages")
        tables = table_names(verification)
        installed_schema = validate_voice_schema_contract(verification, "installed candidate Voice fixture")
        if installed_schema["schemaSha256"] != source_schema["schemaSha256"]:
            raise BlockedError("installed candidate Voice fixture schema fingerprint changed")
        for name in tables:
            if int(verification.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0]) != 0:
                raise BlockedError("installed candidate Voice fixture contains records")
    return {
        "schemaVersion": "zimeiti-candidate-fixture.v1",
        "status": "ready",
        "service": "voice",
        "tableCount": table_count,
        "schemaContractVersion": source_schema["schemaContractVersion"],
        "schemaContractSha256": source_schema["schemaContractSha256"],
        "sourceSchemaSha256": source_schema["schemaSha256"],
        "outputSchemaSha256": installed_schema["schemaSha256"],
        "records": 0,
        "quickCheck": "ok",
        "productionRecordsCopied": 0,
    }


def create_web_service_fixture(source: Path, data_output: Path, voice_output: Path) -> dict[str, Any]:
    # The Web readiness endpoint also opens VOICE_SQLITE_PATH and queries the
    # Voice table. Generate the redacted database first, then the JSON tree;
    # neither operation reads or copies production JSON/business records.
    voice_receipt = create_voice_fixture(source, voice_output)
    data_receipt = create_web_fixture(data_output)
    return {
        "schemaVersion": "zimeiti-candidate-fixture.v1",
        "status": "ready",
        "service": "web",
        "fileCount": data_receipt["fileCount"],
        "tableCount": voice_receipt["tableCount"],
        "schemaContractVersion": voice_receipt["schemaContractVersion"],
        "schemaContractSha256": voice_receipt["schemaContractSha256"],
        "sourceSchemaSha256": voice_receipt["sourceSchemaSha256"],
        "outputSchemaSha256": voice_receipt["outputSchemaSha256"],
        "records": 0,
        "quickCheck": "ok",
        "productionRecordsCopied": 0,
    }


def require_installed_identity() -> None:
    if os.name != "posix":
        return
    own_path = Path(__file__)
    try:
        resolved = own_path.resolve(strict=True)
    except FileNotFoundError as error:
        raise BlockedError("helper executable disappeared") from error
    if resolved != INSTALLED_PATH:
        return
    metadata = require_regular_file(INSTALLED_PATH, "installed helper")
    if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o755:
        raise BlockedError("installed helper must be a single-link root:root 0755 file")


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="zimeiti-candidate-fixture-self-test-") as raw_root:
        root = Path(raw_root).resolve()
        os.chmod(root, 0o700)
        source = root / "source.db"
        connection = sqlite3.connect(source)
        try:
            connection.executescript(
                "CREATE TABLE User(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT,role TEXT,"
                "balance REAL,storageConfigured BOOLEAN,createdAt DATETIME,updatedAt DATETIME);"
                "CREATE TABLE Voice(id TEXT PRIMARY KEY,speakerId TEXT UNIQUE,name TEXT,description TEXT,type TEXT,"
                "category TEXT,tags TEXT,language TEXT,gender TEXT,avatar TEXT,isActive BOOLEAN,isRecommended BOOLEAN,"
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
                "CREATE TABLE CloneLicense(id TEXT PRIMARY KEY,licenseKey TEXT UNIQUE,status TEXT,assignedTo TEXT,"
                "speakerId TEXT,maxTrainings INTEGER,usedTrainings INTEGER,createdAt DATETIME,usedAt DATETIME,"
                "updatedAt DATETIME);"
                "CREATE TABLE Audit(id INTEGER PRIMARY KEY,payload TEXT);"
                "CREATE INDEX VoiceSpeaker ON Voice(speakerId);"
                "CREATE TRIGGER VoiceAudit AFTER INSERT ON Voice BEGIN "
                "INSERT INTO Audit(payload) VALUES (NEW.speakerId); END;"
                "INSERT INTO User(id,email,password) VALUES ('private-user','private@example.invalid','private-password');"
                "INSERT INTO Voice(id,speakerId,name,category,userId) VALUES "
                "('private-voice','private-speaker','Private','private-category','private-user');"
                "INSERT INTO ModelConfig(id,name,modelId,apiKey) VALUES "
                "('private-model','Private','private-model-id','private-api-secret');"
            )
            connection.commit()
        finally:
            connection.close()

        web_output = root / "web"
        web_voice_output = root / "web-voice.db"
        create_web_service_fixture(source, web_output, web_voice_output)
        if set(str(path.relative_to(web_output)).replace(os.sep, "/") for path in web_output.rglob("*.json")) != set(WEB_FIXTURES):
            raise BlockedError("self-test Web inventory mismatch")
        voice_output = root / "candidate.db"
        create_voice_fixture(source, voice_output)
        for database_output in (web_voice_output, voice_output):
            with closing(sqlite_connect_read_only(database_output)) as fixture:
                quick_check(fixture, "self-test output")
                if int(fixture.execute("PRAGMA freelist_count").fetchone()[0]) != 0:
                    raise BlockedError("self-test output retains SQLite free pages")
                for name in table_names(fixture):
                    if int(fixture.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0]) != 0:
                        raise BlockedError("self-test found copied production rows")
            output_bytes = database_output.read_bytes()
            for marker in (b"private@example.invalid", b"private-password", b"private-speaker", b"private-api-secret"):
                if marker in output_bytes:
                    raise BlockedError("self-test found production bytes in candidate fixture")
    print("PASS SELF-TEST: schema-valid empty candidate fixtures; production records copied=0")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--service", choices=("web", "voice"))
    parser.add_argument("--input-root")
    parser.add_argument("--input")
    parser.add_argument("--output-root")
    parser.add_argument("--output")
    parser.add_argument("--voice-output")
    arguments = parser.parse_args()
    if arguments.self_test:
        if any((arguments.service, arguments.input_root, arguments.input, arguments.output_root, arguments.output, arguments.voice_output)):
            parser.error("--self-test cannot be combined with fixture arguments")
        return arguments
    if not arguments.service or not arguments.output_root or not arguments.output:
        parser.error("--service, --output-root and --output are required")
    if not arguments.input_root or not arguments.input:
        parser.error("Web and Voice fixture creation require --input-root and --input for the schema source")
    if arguments.service == "web" and not arguments.voice_output:
        parser.error("Web fixture creation requires --voice-output")
    if arguments.service == "voice" and arguments.voice_output:
        parser.error("Voice fixture creation writes its database to --output and does not accept --voice-output")
    return arguments


def main() -> int:
    try:
        arguments = parse_arguments()
        require_installed_identity()
        if arguments.self_test:
            self_test()
            return 0
        _, output = validate_output(arguments.output_root, arguments.output)
        source = validate_input(arguments.input_root, arguments.input)
        if arguments.service == "web":
            _, voice_output = validate_output(arguments.output_root, arguments.voice_output)
            if output == voice_output:
                raise BlockedError("Web data output and Voice database output must be distinct")
            result = create_web_service_fixture(source, output, voice_output)
        else:
            result = create_voice_fixture(source, output)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except BlockedError as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 2
    except (OSError, sqlite3.Error, ValueError, json.JSONDecodeError) as error:
        print(f"FAIL: {error.__class__.__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
