"""Continuous PM2 stop observer for the in-development release window.

This module is deliberately NOT an executable deployment entry.  Its Linux
implementation reuses the already reviewed, pinned PM2 socket/AMP observer and
keeps a continuous bus socket around an as-yet-unconnected exact-ID stop RPC.
It cannot establish that ingress is held or that no other controller can issue
PM2 commands.  The real release entry therefore remains unconditionally closed.
No production operation is performed by importing this module.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import selectors
import socket
import struct
import sys
import time

PROBE_PATH = (Path(__file__).resolve().parent.parent /
              'fixture-only/unavailable-probe.py')
PROBE_SHA256 = '0000000000000000000000000000000000000000000000000000000000000000'
RPC_PATH_SOURCE = Path(__file__).resolve().parent / 'rpc_stop.py'
RPC_SOURCE_SHA256 = '74a0541b29f9fa0ea08ce8e04cba9042e15bd03e90a85355106744ec47186128'
RPC_PATH = '/fixture/unset-rpc.sock'


class DrainError(Exception):
    """After a stop intent, every error means reconcile; never retry blindly."""


def _load_probe():
    source = PROBE_PATH.read_bytes()
    if hashlib.sha256(source).hexdigest() != PROBE_SHA256:
        raise DrainError('PROBE_SOURCE_CHANGED')
    spec = importlib.util.spec_from_file_location('reviewed_pm2_bus_probe', PROBE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _same_live_process(probe, pid, start):
    try:
        return probe.proc_fields(pid)[1] == start
    except (OSError, ValueError, IndexError):
        return False


def _load_rpc():
    if hashlib.sha256(RPC_PATH_SOURCE.read_bytes()).hexdigest() != RPC_SOURCE_SHA256:
        raise DrainError('RPC_SOURCE_CHANGED')
    spec = importlib.util.spec_from_file_location('one_shot_pm2_rpc', RPC_PATH_SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RpcRequest:
    def __init__(self, sock, reply):
        self.sock, self.reply, self.returncode = sock, reply, None

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        try:
            data = self.sock.recv(65536)
        except BlockingIOError:
            return None
        except OSError:
            raise DrainError('RPC_DISCONNECTED_UNKNOWN') from None
        if not data:
            raise DrainError('RPC_DISCONNECTED_UNKNOWN')
        try:
            if self.reply.feed(data):
                self.returncode = 0
                self.sock.close()
        except Exception:
            raise DrainError('RPC_RESPONSE_UNKNOWN') from None
        return self.returncode


class LinuxContinuousDrain:
    """Private building block; its caller must own a verified release window.

    `checkpoint` is the existing durable Linux journal owner's operation; it
    must persist and fsync the intent before returning.  This is an internal
    interface, not proof that the surrounding window/provider is trusted.
    """

    def __init__(self, checkpoint):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise DrainError('LINUX_ROOT_REQUIRED')
        self.probe = _load_probe()
        self.probe.source_check()
        ns = {'__name__': 'fixed_bus_proc'}
        exec(compile(self.probe.SOURCE, '<pinned-proc>', 'exec'), ns)
        self.ns = ns
        self.binding = self.probe.instance_binding(ns)
        self.checkpoint = checkpoint
        self.poisoned = False
        self.done = set()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.rpc_sock = None
        self.selector = None
        self.frames = self.probe.Frames()
        self.events = self.probe.Events()
        try:
            # The observer already refuses a pub socket reachable by unrelated
            # DAC principals. RPC is equally important for exact-ID control.
            self.rpc_stamp, self.rpc_inode = self._listener(RPC_PATH)
            self.sock.settimeout(2)
            self.sock.connect(self.probe.PUB)
            peer = self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            peer_pid, peer_uid, _ = struct.unpack('3i', peer)
            if peer_pid != self.binding['daemon'] or peer_uid != 0:
                raise DrainError('BUS_PEER_MISMATCH')
            if self.probe.instance_binding(ns) != self.binding:
                raise DrainError('INITIAL_BINDING_CHANGED')
            self.sock.setblocking(False)
            self.selector = selectors.DefaultSelector()
            self.selector.register(self.sock, selectors.EVENT_READ)
            self._assert_daemon()
        except BaseException:
            self.close()
            raise

    def _listener(self, socket_path):
        p = self.probe
        metadata = p.trusted(socket_path, 'socket')
        rows = []
        for line in p.read('/proc/net/unix', 2097152, True).splitlines()[1:]:
            fields = line.split()
            if len(fields) == 8 and fields[7] == socket_path.encode():
                if fields[3] != b'00010000' or fields[4] != b'0001':
                    raise DrainError('RPC_LISTENER_INVALID')
                rows.append(int(fields[6]))
        if len(rows) != 1:
            raise DrainError('RPC_LISTENER_AMBIGUOUS')
        return p.stamp(metadata), rows[0]

    def _assert_daemon(self):
        p, b = self.probe, self.binding
        if p.proc_fields(b['daemon'])[1] != b['start']:
            raise DrainError('PM2_DAEMON_CHANGED')
        command = p.read('/proc/%s/cmdline' % b['daemon'], 65536, True).rstrip(b'\0')
        if hashlib.sha256(command).hexdigest() != b['cmd_sha'] or os.stat('/proc/%s' % b['daemon']).st_uid != 0:
            raise DrainError('PM2_DAEMON_IDENTITY_CHANGED')
        meta = p.trusted(p.PUB, 'socket')
        if p.stamp(meta) != b['socket_stat']:
            raise DrainError('BUS_SOCKET_CHANGED')
        if self._listener(RPC_PATH) != (self.rpc_stamp, self.rpc_inode):
            raise DrainError('RPC_SOCKET_CHANGED')
        owned = set()
        for index, fd in enumerate(Path('/proc/%s/fd' % b['daemon']).iterdir()):
            if index >= 4096:
                raise DrainError('PM2_FD_LIMIT')
            try:
                owned.add(os.readlink(fd))
            except FileNotFoundError:
                continue
        if any('socket:[%d]' % inode not in owned for inode in (b['kernel_inode'], self.rpc_inode)):
            raise DrainError('SOCKET_DAEMON_OWNER_CHANGED')

    def _receive(self, timeout):
        for _, _mask in self.selector.select(timeout):
            try:
                data = self.sock.recv(65536)
            except BlockingIOError:
                continue
            if not data:
                raise DrainError('BUS_DISCONNECTED')
            for parts in self.frames.feed(data):
                self.events.accept(parts)

    def _drain_pending(self):
        # Consume pre-existing messages but do not count them as this stop.
        for _ in range(256):
            if not self.selector.select(0):
                if self.frames.buffer or any(self.events.carry.values()):
                    raise DrainError('PARTIAL_PRESTOP_FRAME')
                return
            self._receive(0)
        raise DrainError('BUS_BACKLOG_LIMIT')

    def _pm2_command(self, pmid):
        # A direct Unix socket cannot spawn/reconnect a PM2 daemon. The RPC
        # method and ID are fixed, and its peer must be the existing daemon.
        rpc = _load_rpc()
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.rpc_sock = s
        s.settimeout(2)
        try:
            s.connect(RPC_PATH)
            peer = s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            peer_pid, peer_uid, _ = struct.unpack('3i', peer)
            if peer_pid != self.binding['daemon'] or peer_uid != 0:
                raise DrainError('RPC_PEER_MISMATCH')
            self._assert_daemon()
            request_id = str(os.getpid())
            # Any send failure could occur after a partial request was sent.
            s.sendall(rpc.encode_stop(pmid, request_id))
            s.setblocking(False)
            return RpcRequest(s, rpc.StopReply(pmid, request_id, self.probe.Frames(), self.probe.parse_json))
        except BaseException:
            s.close()
            raise

    def _ensure_stop_provider(self):
        raise DrainError('EXISTING_DAEMON_RPC_PROVIDER_NOT_CONNECTED')

    def _stop_exact_once(self, pmid):
        """Observe one stop after a durable intent; the actual RPC is closed."""
        if self.poisoned or pmid in self.done or pmid not in (1001, 1002):
            raise DrainError('STOP_REPLAY_FORBIDDEN')
        self._ensure_stop_provider()
        matches = [(pid, start) for pid, start, value in self.binding['idents']
                   if value == str(pmid).encode()]
        if len(matches) != 1:
            raise DrainError('STOP_IDENTITY_INVALID')
        pid, start = matches[0]
        self._assert_daemon()
        if not _same_live_process(self.probe, pid, start):
            raise DrainError('STOP_PROCESS_CHANGED')
        self._drain_pending()
        row = self.events.rows[pmid]
        before = (row['drained_true'], row['drained_false'], row['invalid_stop_marker'])
        # From the instant an intent is attempted any error is UNKNOWN. The
        # caller must use the journal's single-owner, fsync-backed checkpoint.
        self.poisoned = True
        self.checkpoint('stop-intent', pmid, pid, start)
        self._assert_daemon()
        if not _same_live_process(self.probe, pid, start):
            raise DrainError('STOP_PROCESS_CHANGED_AFTER_INTENT_UNKNOWN')
        self._drain_pending()
        if (row['drained_true'], row['drained_false'], row['invalid_stop_marker']) != before:
            raise DrainError('PREEXISTING_STOP_EVENT_UNKNOWN')
        child = self._pm2_command(pmid)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            self._assert_daemon()
            self._receive(0.2)
            if row['drained_false'] != before[1] or row['invalid_stop_marker'] != before[2]:
                raise DrainError('DRAIN_FALSE_OR_INVALID_UNKNOWN')
            if child.poll() is not None and child.returncode != 0:
                raise DrainError('PM2_STOP_FAILED_UNKNOWN')
            if (child.poll() == 0 and row['drained_true'] == before[0] + 1
                    and not _same_live_process(self.probe, pid, start)):
                # PM2-slot replacement, unrelated RPC clients and in-flight
                # detached work remain unproven. This is evidence for further
                # validation, never a standalone release-ready receipt.
                self.checkpoint('stop-observed', pmid, pid, start)
                self.done.add(pmid)
                self.poisoned = False
                return {'pm_id': pmid, 'fresh_drain_log': True,
                        'original_pid_exited': True, 'release_ready': False}
        # Do not kill/retry the command or infer the daemon's final state.
        raise DrainError('DRAIN_TIMEOUT_UNKNOWN')

    def close(self):
        if self.selector is not None:
            self.selector.close()
            self.selector = None
        self.sock.close()
        if self.rpc_sock is not None:
            self.rpc_sock.close()


def execute_release_window():
    # No boolean, environment variable, CLI argument or caller-provided JSON
    # may substitute for the missing authenticated real window owner.
    raise DrainError('REAL_WINDOW_OWNER_NOT_CONNECTED')
