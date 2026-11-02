"""Continuous read-only PM2 observations; never a production drain authority.

The real runtime reuses the exact reviewed bus observer, including SO_PEERCRED,
daemon/socket checks and its bounded AMP parser. No method sends RPC, changes
socket permissions, kills workers, or releases maintenance. The production
factory remains closed: a PM2 log carries an ID/name, not a PID/start identity.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import types

WORK = Path(__file__).resolve().parents[2]
LIVE = WORK / 'live-drain-provider-61e9/live_drain.py'
LIVE_SHA = '7196856082edce034bb3cbe41e18a187068b645a6cb2d7a4450ac818477ea306'
PROBE = WORK / 'worker-quiescence-plan-61e9/release-window/service-detail-v2/bus_probe.py'
PROBE_SHA = 'cf2246ace14989c6212b5d63f10c23acc2459928989b9346633de38223f3d32e'
IDS = (18, 19)


class WatchError(RuntimeError):
    pass


def _fail(code):
    raise WatchError(code)


def _hash(value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')
    return hashlib.sha256(raw).hexdigest()


def _load_bytes(file, expected, name):
    raw = file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        _fail('WATCH_DEPENDENCY_CHANGED')
    module = types.ModuleType(name)
    module.__file__ = str(file)
    # Execute the bytes actually hashed, not a second import/path or cached pyc.
    exec(compile(raw, str(file), 'exec', dont_inherit=True), module.__dict__)
    return module


def load_parser():
    return _load_bytes(PROBE, PROBE_SHA, 'worker_watch_pinned_bus')


class SerializedOwner:
    """Use this same wrapper for ALL callers of the underlying journal owner.

    Serialization is not authentication. Its supplied owner must already belong
    to the installed, authenticated, one-shot release session. In particular,
    do not keep using the unwrapped owner concurrently in another component.
    """
    def __init__(self, owner):
        if any(not callable(getattr(owner, n, None)) for n in ('assert_live', 'checkpoint', 'mark_unknown')):
            _fail('WATCH_OWNER_REQUIRED')
        self._owner = owner
        self._lock = threading.RLock()

    def assert_live(self):
        with self._lock:
            return self._owner.assert_live()

    def checkpoint(self, phase, details):
        with self._lock:
            self._owner.assert_live()
            return self._owner.checkpoint(phase, copy.deepcopy(details))

    def set_deadline(self, deadline):
        with self._lock:
            return self._owner.set_deadline(deadline)

    def assert_bound(self):
        with self._lock:
            self._owner.assert_live()
            return self._owner.assert_bound()

    def verify_file(self, path, sha256):
        with self._lock:
            self._owner.assert_live()
            return self._owner.verify_file(path, sha256)

    def mark_unknown(self):
        with self._lock:
            return self._owner.mark_unknown()

    def __getattr__(self, name):
        if name not in ('assert_exclusive_config_writer', 'assert_candidate_prevalidated',
                        'assert_install_allowed', 'assert_restore_allowed'):
            raise AttributeError(name)
        method = getattr(self._owner, name)
        def invoke(*args, **kwargs):
            with self._lock:
                return method(*args, **kwargs)
        return invoke


class LinuxRuntime:
    """Internal Linux building block. Construction connects a PUB socket.

    The owner must establish its reviewed socket restriction/exclusion before
    constructing this runtime. Existing peers/root operators are NOT excluded
    by this runtime. The fixed historical worker identities are not refreshed.
    """
    def __init__(self, owner):
        if sys.platform != 'linux' or os.geteuid() != 0:
            _fail('WATCH_LINUX_ROOT_REQUIRED')
        owner.assert_live()
        self.probe = load_parser()
        live = _load_bytes(LIVE, LIVE_SHA, 'worker_watch_pinned_live')
        live._load_probe = lambda: self.probe
        self.inner = live.LinuxContinuousDrain(lambda *_: _fail('WATCH_RPC_FORBIDDEN'))
        try:
            self.binding = copy.deepcopy(self.inner.binding)
            self.boot = self.probe.read('/proc/sys/kernel/random/boot_id', 128, True).strip()
            self.namespaces = self._namespaces()
            self.baseline = tuple(sorted((pid, start, int(pmid)) for pid, start, pmid, *_ in self.binding['idents']))
            self.sample()
        except BaseException:
            self.inner.close()
            raise

    @staticmethod
    def _namespaces():
        return tuple((n, os.stat('/proc/self/ns/' + n).st_dev, os.stat('/proc/self/ns/' + n).st_ino)
                     for n in ('pid', 'user', 'mnt', 'net'))

    def sample(self):
        self.inner._assert_daemon()
        if self._namespaces() != self.namespaces or self.probe.read('/proc/sys/kernel/random/boot_id', 128, True).strip() != self.boot:
            _fail('WATCH_BOOT_OR_NAMESPACE_CHANGED')
        info, identities, paths, current = self.inner.ns['processes']()
        if not info['scan_complete'] or info['scan_races'] or info['worker_count'] != len(identities):
            _fail('WATCH_SCAN_INCOMPLETE')
        if paths != self.binding['paths'] and identities:
            _fail('WATCH_WORKER_PATH_CHANGED')
        if current != self.binding['current']:
            _fail('WATCH_RELEASE_CHANGED')
        for row in info['workers']:
            if not all(row[k] for k in ('role_flag_matches', 'release_matches', 'commit_matches',
                                       'cwd_matches_current', 'pm2_id_present', 'shutdown_message_enabled')):
                _fail('WATCH_WORKER_IDENTITY_CHANGED')
        result = []
        for pid, start, pmid, *_ in identities:
            if self.probe.proc_fields(pid)[1] != start:
                _fail('WATCH_PROCESS_SCAN_RACE')
            result.append((pid, start, int(pmid)))
        self.inner._assert_daemon()
        return tuple(sorted(result))

    def receive(self, timeout):
        # Original bounded parser/Events only; no RPC method is invoked.
        self.inner._receive(timeout)

    def counters(self):
        return {i: dict(self.inner.events.rows[i]) for i in IDS}

    def partial(self):
        return bool(self.inner.frames.buffer or any(self.inner.events.carry.values()))

    def close(self):
        self.inner.close()


class _ContinuousWatch:
    def __init__(self, owner, runtime, *, sample_interval=0.25, max_seconds=180, max_stale_seconds=5):
        try:
            if not isinstance(owner, SerializedOwner):
                _fail('WATCH_SERIALIZED_OWNER_REQUIRED')
            limits = (sample_interval, max_seconds, max_stale_seconds)
            if (any(type(v) not in (int, float) for v in limits) or
                    not (0.01 <= sample_interval <= 1 and 1 <= max_seconds <= 900 and 1 <= max_stale_seconds <= 15)):
                _fail('WATCH_LIMIT_INVALID')
            baseline = tuple(runtime.baseline)
            if (len(baseline) != 2 or any(not isinstance(r, tuple) or len(r) != 3 for r in baseline)
                    or any(type(v) is not int or v <= 0 for row in baseline for v in row)
                    or {r[2] for r in baseline} != set(IDS) or len({r[0] for r in baseline}) != 2):
                _fail('WATCH_BASELINE_INVALID')
        except BaseException:
            runtime.close()
            raise
        self.owner, self.runtime = owner, runtime
        self.pid = os.getpid()
        self._mutex = threading.RLock()
        self._state_lock = threading.Lock()
        # Stop send and close transition are serialized. An in-flight send
        # owns this gate until it finishes; close cannot reclaim its observer.
        self._send_gate = threading.Lock()
        self._close_requested = threading.Event()
        self._stop = threading.Event()
        self._closing = threading.Event()
        self._runtime_closed = threading.Event()
        self._notification_done = threading.Event()
        self._notifier = None
        self._thread = None
        self._unknown = False
        self._closed = False
        self._started = time.monotonic()
        self._deadline = self._started + max_seconds
        self._interval, self._stale = sample_interval, max_stale_seconds
        self._last_sample = None
        self._generation = 0
        self._observed = None
        self._intents, self._observations = {}, set()
        self.baseline = baseline
        self.binding_sha256 = _hash(self.baseline)
        try:
            self._sample()
            owner.checkpoint('worker-watch-created', {'bindingSha256': self.binding_sha256,
                             'generations': [list(x) for x in self.baseline], 'releaseReady': False})
            self._thread = threading.Thread(target=self._pump, name='owned-pm2-pub-watch', daemon=True)
            self._thread.start()
        except BaseException:
            self._poison('WATCH_START_UNKNOWN')
            self._close_runtime()
            raise

    def _notify_unknown(self, code):
        try:
            try:
                self.owner.checkpoint('worker-watch-unknown', {'bindingSha256': self.binding_sha256,
                                      'reason': code, 'releaseReady': False})
            except BaseException:
                pass
            try:
                self.owner.mark_unknown()
            except BaseException:
                pass
        finally:
            self._notification_done.set()

    def _poison(self, code, *, asynchronous=False):
        # The write-ahead claim/intents remain on every crash. Even failure to
        # journal UNKNOWN cannot turn the earlier claim into a success receipt.
        # Independent of the receive/sample lock: close timeout must poison
        # immediately even while that lock is held by a blocked runtime call.
        with self._state_lock:
            if self._unknown:
                return
            self._unknown = True
            self._generation += 1
            self._stop.set()
            if asynchronous:
                self._notifier = threading.Thread(target=self._notify_unknown, args=(code,),
                                                  name='owned-watch-unknown-notifier', daemon=True)
                self._notifier.start()
        if not asynchronous:
            self._notify_unknown(code)

    def _close_runtime(self):
        # Only called after the pump has stopped using the runtime. Public
        # operations serialize on this lock and see closing/unknown first.
        with self._mutex:
            if not self._runtime_closed.is_set():
                try:
                    self.runtime.close()
                except BaseException:
                    self._poison('WATCH_RUNTIME_CLOSE_UNKNOWN', asynchronous=True)
                    raise
                self._runtime_closed.set()
            self._closed = True

    def _reject_closing(self):
        if self._close_requested.is_set() or self._closing.is_set():
            _fail('WATCH_CLOSING')

    def send_once_guarded(self, send):
        """Serialize one bounded send with observer close for this owner.

        The caller holds the watch mutex and performs its own durable intent,
        slot and pidfd checks. This is lifecycle coordination, not authority.
        A close requested during a claimed send makes its outcome UNKNOWN.
        """
        if not callable(send):
            _fail('WATCH_SEND_INVALID')
        self._reject_closing()
        with self._send_gate:
            self._check()
            send()
            self._reject_closing()

    def _check(self):
        self._reject_closing()
        if self._unknown or self._closed or os.getpid() != self.pid:
            _fail('WATCH_UNAVAILABLE')
        if time.monotonic() >= self._deadline:
            _fail('WATCH_DEADLINE')
        self.owner.assert_live()

    def _sample(self):
        self._check()
        started = time.monotonic()
        rows = tuple(self.runtime.sample())
        finished = time.monotonic()
        self._check()
        if getattr(self.runtime, 'candidate_transition_active', False):
            # The private transition runtime has independently checked every
            # candidate PID/start against proc, pidfd and fixed PM2 slots.
            self.runtime.assert_candidate_rows(rows)
            self._observed = rows
            self._last_sample = finished
            self._generation += 1
            return
        if len(rows) != len(set(rows)) or any(r not in self.baseline for r in rows):
            _fail('WATCH_REPLACEMENT_OBSERVED')
        present = {r[2] for r in rows}
        for row in self.baseline:
            if row[2] not in present and row[2] not in self._intents:
                _fail('WATCH_EXIT_WITHOUT_INTENT')
            if row[2] in present and row[2] in self._observations:
                _fail('WATCH_STOPPED_GENERATION_REAPPEARED')
        self._observed = rows
        self._last_sample = finished
        self._generation += 1

    def _pump(self):
        try:
            while not self._stop.is_set():
                with self._mutex:
                    # Terminal owner may have set stop while this thread
                    # waited for the mutex; do not touch the closed FD3.
                    if self._stop.is_set():
                        break
                    try:
                        self._check()
                        self.runtime.receive(min(self._interval, 0.25))
                        self._sample()
                        counts = self.runtime.counters()
                        for pmid, intent in self._intents.items():
                            row, before = counts[pmid], intent['counters']
                            if row['drained_false'] != before['drained_false'] or row['invalid_stop_marker'] != before['invalid_stop_marker']:
                                _fail('WATCH_NEGATIVE_DRAIN_MARKER')
                            if row['drained_true'] > before['drained_true'] + 1:
                                _fail('WATCH_DUPLICATE_DRAIN_MARKER')
                    except BaseException:
                        self._poison('WATCH_PUMP_UNKNOWN', asynchronous=True)
                        raise
                # Yield outside the lock so protocol operations cannot starve
                # behind a permanently readable/quiet observer socket.
                self._stop.wait(0.001)
        except BaseException:
            self._poison('WATCH_PUMP_UNKNOWN', asynchronous=True)
        finally:
            # Deferred cleanup also runs after close() timed out. Never close
            # descriptors concurrently with a runtime receive/sample call.
            try:
                self._close_runtime()
            except BaseException:
                pass

    def record_stop_intent(self, pmid):
        """Persist intent BEFORE an independently authorized sender may act.

        A log received after this point may still have been buffered beforehand.
        It is not a cryptographically/atomically bound stop acknowledgement.
        """
        self._reject_closing()
        with self._mutex:
            try:
                self._check()
                if type(pmid) is not int or pmid not in IDS or pmid in self._intents:
                    _fail('WATCH_STOP_REPLAY')
                self._sample()
                if self.runtime.partial():
                    _fail('WATCH_PARTIAL_PRESTOP_FRAME')
                original = next(r for r in self.baseline if r[2] == pmid)
                if original not in self._observed:
                    _fail('WATCH_PROCESS_ALREADY_ABSENT')
                counters = self.runtime.counters()[pmid]
                self.owner.checkpoint('worker-stop-intent', {'bindingSha256': self.binding_sha256,
                                     'generation': list(original), 'releaseReady': False})
                self._intents[pmid] = {'counters': counters, 'at': time.monotonic()}
                self._sample()
                return {'bindingSha256': self.binding_sha256, 'pmId': pmid, 'rpcSent': False,
                        'drainIdentityProven': False, 'releaseReady': False}
            except BaseException:
                self._poison('WATCH_INTENT_UNKNOWN')
                raise

    def observe_stopped_generation(self, pmid):
        self._reject_closing()
        with self._mutex:
            try:
                self._check()
                if type(pmid) is not int or pmid not in self._intents or pmid in self._observations:
                    _fail('WATCH_STOP_OBSERVATION_PHASE')
                self._sample()
                if any(r[2] == pmid for r in self._observed):
                    _fail('WATCH_ORIGINAL_STILL_PRESENT')
                row, before = self.runtime.counters()[pmid], self._intents[pmid]['counters']
                delta = row['drained_true'] - before['drained_true']
                if (self.runtime.partial() or row['drained_false'] != before['drained_false']
                        or row['invalid_stop_marker'] != before['invalid_stop_marker'] or delta != 1):
                    _fail('WATCH_DRAIN_OBSERVATION_INCOMPLETE')
                evidence = {'bindingSha256': self.binding_sha256, 'pmId': pmid,
                            'originalGenerationAbsentObserved': True, 'replacementAbsentObserved': True,
                            'oneDrainMarkerObserved': True, 'drainIdentityProven': False,
                            'exclusiveControllerProven': False, 'releaseReady': False}
                self.owner.checkpoint('worker-generation-absence-observed', evidence)
                self._observations.add(pmid)
                self._sample()
                return dict(evidence, evidenceSha256=_hash(evidence))
            except BaseException:
                self._poison('WATCH_STOP_OBSERVATION_UNKNOWN')
                raise

    def assert_continuity(self):
        self._reject_closing()
        with self._mutex:
            try:
                self._check()
                if not self._thread or not self._thread.is_alive() or self._last_sample is None:
                    _fail('WATCH_PUMP_STALE')
                self._sample()
                return {'bindingSha256': self.binding_sha256, 'observedStoppedIds': sorted(self._observations),
                        'pumpAlive': True, 'releaseReady': False, 'drainIdentityProven': False}
            except BaseException:
                self._poison('WATCH_CONTINUITY_UNKNOWN')
                raise

    def require_release_authority(self):
        # Existing AMP/PM2 logs have no PID/start or release-session challenge.
        # Never manufacture WORKERS_DRAINED from an ID/name and an empty scan.
        _fail('WATCH_STOP_GENERATION_AND_EXCLUSIVITY_NOT_AUTHENTICATED')

    def close(self):
        """Close only our observer; this is not a successful window handoff."""
        # Immediately reject new operations. Close can transition the watch
        # only after an already claimed send has released the send gate.
        self._close_requested.set()
        if self._runtime_closed.is_set():
            return
        if not self._send_gate.acquire(timeout=2):
            # Never close the observer under an in-flight sender. An outer
            # process deadline must reconcile a permanently blocked send.
            self._poison('WATCH_SEND_CLOSE_UNKNOWN', asynchronous=True)
            _fail('WATCH_CLOSE_UNKNOWN')
        try:
            self._closing.set()
            self._stop.set()
        finally:
            self._send_gate.release()
        if self._thread:
            self._thread.join(timeout=2)
            if self._thread.is_alive():
                # Do not acquire a lock possibly held by a stuck sample/fsync.
                # Never close/reuse its runtime while the reader may use it.
                self._poison('WATCH_CLOSE_UNKNOWN', asynchronous=True)
                _fail('WATCH_CLOSE_UNKNOWN')
        self._close_runtime()


def open_linux_observation_primitive(owner):
    """Internal observation only; not callable from external request frames."""
    if not isinstance(owner, SerializedOwner):
        _fail('WATCH_SERIALIZED_OWNER_REQUIRED')
    return _ContinuousWatch(owner, LinuxRuntime(owner))


def open_fixture_watch(owner, runtime, **limits):
    """Synthetic tests only; Linux requires an isolated network namespace.

    Cannot create a LinuxRuntime or a release authority. The test supplies an
    owned socketpair and synthetic process snapshots, never production paths.
    """
    if isinstance(runtime, LinuxRuntime):
        _fail('WATCH_FIXTURE_RUNTIME_REQUIRED')
    try:
        if set(limits) - {'sample_interval', 'max_seconds', 'max_stale_seconds'}:
            _fail('WATCH_LIMIT_INVALID')
        if sys.platform == 'linux' and os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
            _fail('WATCH_FIXTURE_ISOLATION_REQUIRED')
    except BaseException:
        runtime.close()
        raise
    return _ContinuousWatch(owner, runtime, **limits)


def open_production_worker_provider(*_args, **_kwargs):
    _fail('WATCH_AUTHENTICATED_STOP_PROVIDER_NOT_CONNECTED')


if __name__ == '__main__':
    raise SystemExit('DISABLED: no standalone worker executor')
