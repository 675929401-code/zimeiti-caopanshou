"""Internal one-shot stop mechanics, NOT an authenticated production provider.

The production factory stays closed. Callbacks below are private installed
capabilities, never JSON/CLI flags. No historical UNKNOWN item is modified.
"""
import hashlib
import os
from pathlib import Path
import select
import secrets
import socket
import struct
import sys
import time

import continuous_watch as watch_module
import current_identity as current_module

RPC_FILE = watch_module.WORK / 'live-drain-provider-61e9/rpc_stop.py'
RPC_SHA = '64c3270ce40ce94c22d8cc432edbbe86afb6a4a05eaf264be36b16900a1e3010'
RPC_PATH = '/root/.pm2/rpc.sock'
ZERO_KEYS = frozenset(('video_dispatch_live_leases', 'video_dispatch_dispatching',
    'human_segments_live_leases', 'human_segments_dispatching', 'video_poll_live_leases',
    'database_active_other', 'database_idle_in_transaction_other',
    'sqlite_running_tasks', 'sqlite_execution_leases'))
HISTORY_KEYS = frozenset(('video_dispatch_unknown', 'human_segments_unknown'))


class StopError(RuntimeError):
    pass


def fail(code):
    raise StopError(code)


def codec():
    return watch_module._load_bytes(RPC_FILE, RPC_SHA, 'exact_stop_pinned_rpc')


def _boot():
    with open('/proc/sys/kernel/random/boot_id', 'rb') as f:
        raw = f.read(129).strip()
    if len(raw) != 36:
        fail('STOP_BOOT_INVALID')
    return raw


def _start(pid):
    with open('/proc/%d/stat' % pid, 'rb') as f:
        raw = f.read(8193)
    if len(raw) > 8192:
        fail('STOP_PROC_LIMIT')
    tail = raw.rsplit(b')', 1)[1].split()
    if tail[0] == b'Z':
        fail('STOP_ORIGINAL_ALREADY_EXITED')
    return int(tail[19])


class LinuxPidfd:
    """Pins the original kernel process without sending it any signal."""
    def __init__(self, pid, start, boot):
        if sys.platform != 'linux' or not hasattr(os, 'pidfd_open'):
            fail('STOP_PIDFD_REQUIRED')
        if type(pid) is not int or pid <= 1 or type(start) is not int or start <= 0:
            fail('STOP_GENERATION_INVALID')
        self.pid, self.start, self.boot, self.fd = pid, start, boot, None
        if _boot() != boot or _start(pid) != start:
            fail('STOP_GENERATION_CHANGED')
        self.fd = os.pidfd_open(pid, 0)
        try:
            if _boot() != boot or _start(pid) != start or self.exited():
                fail('STOP_PIDFD_RACE')
        except BaseException:
            self.close()
            raise

    def exited(self):
        if self.fd is None or _boot() != self.boot:
            fail('STOP_PIDFD_UNAVAILABLE')
        return bool(select.select([self.fd], [], [], 0)[0])

    def assert_original_live(self):
        if self.exited() or _start(self.pid) != self.start:
            fail('STOP_ORIGINAL_CHANGED')

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class StrictReply:
    """Original pinned RPC codec plus exact unique_id binding. No env output."""
    def __init__(self, pmid, request_id, unique_id):
        parser = watch_module.load_parser()
        self.base = codec().StopReply(pmid, request_id, parser.Frames(), parser.parse_json)
        self.extra = parser.Frames()
        self.parse_json = parser.parse_json
        self.pmid, self.unique_id = pmid, unique_id
        self.raw = bytearray()
        self.complete = False

    def feed(self, raw):
        if self.complete or not raw or len(self.raw) + len(raw) > 131072:
            fail('STOP_REPLY_LIMIT_OR_REPLAY')
        self.raw.extend(raw)
        done = self.base.feed(raw)
        for parts in self.extra.feed(raw):
            packet = self.parse_json(parts[0][2:])
            value = packet['args'][0]
            env = value['pm2_env']
            if (type(value['pm_id']) is not int or type(env['pm_id']) is not int or
                    type(value['pid']) is not int or env.get('unique_id') != self.unique_id):
                fail('STOP_REPLY_SLOT_CHANGED')
        self.complete = done
        return done

    def digest(self):
        if not self.complete:
            fail('STOP_REPLY_INCOMPLETE')
        return hashlib.sha256(self.raw).hexdigest()


class _SocketRpc:
    """Owns one already verified connection. Exactly one send attempt."""
    def __init__(self, sock, guard, pmid, unique_id):
        self.sock, self.guard, self.pmid = sock, guard, pmid
        self.request_id = str(secrets.randbits(64))
        self.reply = StrictReply(pmid, self.request_id, unique_id)
        self.attempted = False

    def send_once(self, before_write=None):
        if self.attempted:
            fail('STOP_RPC_REPLAY')
        wire = codec().encode_stop(self.pmid, self.request_id)
        self.guard()
        self.sock.settimeout(2)
        if before_write is not None:
            before_write()
        self.attempted = True  # Partial send is UNKNOWN and can never retry.
        self.sock.sendall(wire)
        self.sock.setblocking(False)
        self.guard()

    def poll(self):
        self.guard()
        if self.reply.complete:
            try:
                extra = self.sock.recv(1)
            except BlockingIOError:
                return True
            if extra:
                fail('STOP_RPC_TRAILING_REPLY')
            return True
        try:
            raw = self.sock.recv(65536)
        except BlockingIOError:
            return False
        if not raw:
            fail('STOP_RPC_DISCONNECTED_UNKNOWN')
        return self.reply.feed(raw)

    def close(self):
        self.sock.close()


def _assert_peer(sock, daemon_pid):
    peer = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if peer[0] != daemon_pid or peer[1] != 0:
        fail('STOP_RPC_PEER_INVALID')


def _open_linux_rpc(watch, pmid, unique_id):
    if type(watch.runtime) is not current_module._CurrentRuntime:
        fail('STOP_CURRENT_LINUX_RUNTIME_REQUIRED')
    inner = watch.runtime.inner
    inner._assert_daemon()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(2)
        sock.connect(RPC_PATH)
        _assert_peer(sock, inner.binding['daemon'])
        inner._assert_daemon()
        return _SocketRpc(sock, inner._assert_daemon, pmid, unique_id)
    except BaseException:
        sock.close()
        raise


class _ExactStop:
    """Private coordinator. Provider construction/authentication is still missing.

    capabilities: session_id, assert_exclusive(), slot(pmid), activity(phase),
    open_pidfd(pid,start), open_rpc(pmid,unique_id). These must originate in the
    same trusted session as watch.owner. A caller-created object is not proof.
    """
    def __init__(self, watch, capabilities, timeout=45):
        if not isinstance(watch, watch_module._ContinuousWatch):
            fail('STOP_WATCH_REQUIRED')
        if type(timeout) not in (int, float) or not 1 <= timeout <= 60:
            fail('STOP_TIMEOUT_INVALID')
        if not all(callable(getattr(capabilities, key, None)) for key in
                   ('assert_exclusive', 'slot', 'activity', 'assert_activity_live', 'open_pidfd', 'open_rpc')):
            fail('STOP_CAPABILITY_REQUIRED')
        if getattr(capabilities, 'owner', None) is not watch.owner:
            fail('STOP_OWNER_MISMATCH')
        if type(getattr(capabilities, 'session_id', None)) is not str or not 1 <= len(capabilities.session_id) <= 128:
            fail('STOP_SESSION_REQUIRED')
        self.watch, self.cap, self.timeout = watch, capabilities, timeout
        self.consumed = set()

    def _guard(self, deadline):
        self.watch._check()
        if time.monotonic() >= deadline:
            fail('STOP_DEADLINE_UNKNOWN')
        self.cap.assert_exclusive()
        self.watch._sample()
        # The background pump is excluded by our RLock, so preserve its checks
        # for ALL prior stop intents, not just the currently targeted slot.
        counts = self.watch.runtime.counters()
        for pmid, intent in self.watch._intents.items():
            row, before = counts[pmid], intent['counters']
            if (row['drained_false'] != before['drained_false'] or
                    row['invalid_stop_marker'] != before['invalid_stop_marker'] or
                    row['drained_true'] > before['drained_true'] + 1):
                fail('STOP_PRIOR_MARKER_UNKNOWN')
        self.watch._check()
        if time.monotonic() >= deadline:
            fail('STOP_DEADLINE_UNKNOWN')

    def _activity(self, phase, deadline):
        began = time.monotonic_ns()
        record = self.cap.activity(phase)
        ended = time.monotonic_ns()
        keys = {'sessionId', 'bindingSha256', 'phase', 'observedAtNs', 'counts', 'evidenceSha256'}
        if (type(record) is not dict or set(record) != keys or
                record['sessionId'] != self.cap.session_id or
                record['bindingSha256'] != self.watch.binding_sha256 or record['phase'] != phase or
                type(record['observedAtNs']) is not int or not began <= record['observedAtNs'] <= ended or
                ended - began > 5_000_000_000 or type(record['counts']) is not dict or
                set(record['counts']) != ZERO_KEYS | HISTORY_KEYS or
                any(type(v) is not int or v < 0 for v in record['counts'].values()) or
                any(record['counts'][k] != 0 for k in ZERO_KEYS) or
                type(record['evidenceSha256']) is not str or len(record['evidenceSha256']) != 64 or
                any(c not in '0123456789abcdef' for c in record['evidenceSha256'])):
            fail('STOP_ACTIVITY_UNPROVEN')
        self._guard(deadline)
        return record['evidenceSha256']

    def stop_once(self, pmid):
        w = self.watch
        w._reject_closing()
        with w._mutex:
            pidfd = rpc = None
            try:
                if type(pmid) is not int or pmid not in (18, 19) or pmid in self.consumed:
                    fail('STOP_REPLAY_FORBIDDEN')
                self.consumed.add(pmid)  # Even pre-send uncertainty consumes this attempt.
                deadline = time.monotonic() + self.timeout
                self._guard(deadline)
                pid, start, _ = next(x for x in w.baseline if x[2] == pmid)
                before = self.cap.slot(pmid)
                if (type(before) is not dict or set(before) != {'pm_id', 'pid', 'start_ticks', 'unique_id', 'status'} or
                        before['pm_id'] != pmid or before['pid'] != pid or before['start_ticks'] != start or
                        before['status'] != 'online' or type(before['unique_id']) is not str or
                        not 1 <= len(before['unique_id']) <= 128 or not before['unique_id'].isascii()):
                    fail('STOP_SLOT_UNPROVEN')
                unique = before['unique_id']
                pidfd = self.cap.open_pidfd(pid, start)
                pidfd.assert_original_live()
                pre = self._activity('before-stop-%d' % pmid, deadline)
                # Consume existing complete frames under the SAME PUB pump lock.
                # This is not a PM2 internal queue barrier; exclusion provider
                # must supply the stronger ordering assumption/proof.
                frames = getattr(w.runtime, 'frames', None)
                if frames is None:
                    frames = w.runtime.inner.frames
                for _ in range(256):
                    old = frames.total
                    w.runtime.receive(0)
                    if frames.total == old:
                        break
                else:
                    fail('STOP_BUS_BACKLOG')
                if w.runtime.partial():
                    fail('STOP_BUS_PARTIAL')
                self._guard(deadline)
                if self.cap.slot(pmid) != before:
                    fail('STOP_SLOT_CHANGED')
                rpc = self.cap.open_rpc(pmid, unique)
                self._guard(deadline)
                pidfd.assert_original_live()
                w.record_stop_intent(pmid)
                w.owner.checkpoint('worker-exact-rpc-intent', {'pmId': pmid, 'pid': pid,
                    'startTicks': start, 'slotSha256': watch_module._hash(before),
                    'bindingSha256': w.binding_sha256, 'activityBeforeSha256': pre,
                    'releaseReady': False})
                self._guard(deadline)
                pidfd.assert_original_live()
                if self.cap.slot(pmid) != before:
                    fail('STOP_SLOT_CHANGED_AFTER_INTENT')
                w.runtime.receive(0)
                if w.runtime.partial() or w.runtime.counters()[pmid] != w._intents[pmid]['counters']:
                    fail('STOP_PRE_SEND_EVENT_UNKNOWN')
                self._guard(deadline)
                # watch.close and this single send own the same lifecycle gate.
                # A close requested during the bounded send makes it UNKNOWN;
                # close cannot reclaim the observer beneath an active sender.
                def before_write():
                    # The RPC guard and owner assertion may block after the
                    # preceding _guard. Recheck deadline, close and generation
                    # immediately before the one send; expiration cannot be
                    # converted into a late stop request.
                    if time.monotonic() >= deadline:
                        fail('STOP_DEADLINE_UNKNOWN')
                    w._check()
                    if time.monotonic() >= deadline:
                        fail('STOP_DEADLINE_UNKNOWN')
                    pidfd.assert_original_live()
                    self.cap.assert_activity_live(deadline)
                    if time.monotonic() >= deadline:
                        fail('STOP_DEADLINE_UNKNOWN')
                    w._check()
                w.send_once_guarded(lambda: rpc.send_once(before_write))
                while True:
                    self._guard(deadline)
                    # Pump manually while holding its lock; no parallel parser.
                    w.runtime.receive(.02)
                    self._guard(deadline)
                    row = w.runtime.counters()[pmid]
                    origin = w._intents[pmid]['counters']
                    if (row['drained_false'] != origin['drained_false'] or
                            row['invalid_stop_marker'] != origin['invalid_stop_marker'] or
                            row['drained_true'] > origin['drained_true'] + 1):
                        fail('STOP_DRAIN_MARKER_UNKNOWN')
                    replied = rpc.poll()
                    exited = pidfd.exited()
                    if replied and exited and row['drained_true'] == origin['drained_true'] + 1:
                        break
                after = self.cap.slot(pmid)
                if after != {'pm_id': pmid, 'pid': 0, 'unique_id': unique, 'status': 'stopped'}:
                    fail('STOP_FINAL_SLOT_CHANGED')
                observation = w.observe_stopped_generation(pmid)
                post = self._activity('after-stop-%d' % pmid, deadline)
                self._guard(deadline)
                if self.cap.slot(pmid) != after or not pidfd.exited():
                    fail('STOP_FINAL_RECHECK_FAILED')
                # A valid first response does not allow a later duplicate or
                # partial extra frame that arrived during post-stop checks.
                # Recheck the same socket immediately before writing evidence.
                if not rpc.poll():
                    fail('STOP_FINAL_RPC_INCOMPLETE')
                proof = {'pmId': pmid, 'bindingSha256': w.binding_sha256,
                    'slotSha256': watch_module._hash(before), 'rpcReceiptSha256': rpc.reply.digest(),
                    'activityBeforeSha256': pre, 'activityAfterSha256': post,
                    'observationSha256': observation['evidenceSha256'], 'pidfdExited': True,
                    'releaseReady': False, 'productionProviderAuthenticated': False}
                w.owner.checkpoint('worker-exact-stop-observed', proof)
                self._guard(deadline)
                # A response arriving while fsync was in progress invalidates
                # the return value too; the owner must retain UNKNOWN.
                if not rpc.poll():
                    fail('STOP_FINAL_RPC_INCOMPLETE')
                return proof
            except BaseException:
                w._poison('WATCH_EXACT_STOP_UNKNOWN', asynchronous=True)
                raise StopError('STOP_OUTCOME_UNKNOWN_NO_RETRY') from None
            finally:
                cleanup_failed = False
                for owned in (rpc, pidfd):
                    if owned is not None:
                        try:
                            owned.close()
                        except BaseException:
                            cleanup_failed = True
                            w._poison('WATCH_STOP_RESOURCE_UNKNOWN', asynchronous=True)
                if cleanup_failed:
                    raise StopError('STOP_RESOURCE_OUTCOME_UNKNOWN_NO_RETRY') from None


def open_production_exact_stop(*_args, **_kwargs):
    fail('STOP_AUTHENTICATED_OWNER_ACTIVITY_AND_EXCLUSIVITY_NOT_CONNECTED')


if __name__ == '__main__':
    raise SystemExit('DISABLED: no standalone exact stop executor')
