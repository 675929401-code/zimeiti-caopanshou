"""Fixed-path Linux PM2 socket restriction primitives; no CLI or auto-recovery.

The release-window entry remains closed. These primitives only maintain the
same process's file descriptors and a caller-owned fsync journal. They do not
claim that root operators or previously connected peers are excluded.
"""
import errno
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys

ENDPOINTS = {'pub': '/fixture/unset-pub.sock', 'rpc': '/fixture/unset-rpc.sock'}
DIAG = (Path(__file__).resolve().parent.parent /
        'fixture-only/unavailable-diag.py')
DIAG_SHA = '0000000000000000000000000000000000000000000000000000000000000000'


class ScopeError(Exception):
    pass


def load_diag():
    if hashlib.sha256(DIAG.read_bytes()).hexdigest() != DIAG_SHA:
        raise ScopeError('DIAG_SOURCE_CHANGED')
    spec = importlib.util.spec_from_file_location('fixed_unix_diag', DIAG)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stamp(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_ctime_ns)


def _safe_parents(path):
    current = Path('/')
    for part in Path(path).parts[1:-1]:
        current /= part
        meta = os.lstat(current)
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise ScopeError('SOCKET_PARENT_UNSAFE')


def _no_acl(path):
    try:
        os.getxattr(path, 'system.posix_acl_access', follow_symlinks=False)
    except OSError as exc:
        if exc.errno == errno.ENODATA:
            return
        raise ScopeError('SOCKET_ACL_UNPROVEN') from None
    raise ScopeError('SOCKET_ACL_PRESENT')


class SocketScope:
    """Owner-only state; after any uncertain mutation never retry in process."""

    def __init__(self, checkpoint):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ScopeError('LINUX_ROOT_REQUIRED')
        self.checkpoint = checkpoint
        self.fds = {}
        self.before = {}
        self.after = {}
        self.state = 'initial'
        try:
            for role, path in ENDPOINTS.items():
                _safe_parents(path)
                prior = os.lstat(path)
                if not stat.S_ISSOCK(prior.st_mode) or prior.st_uid != 0 or prior.st_gid != 0 or stat.S_IMODE(prior.st_mode) != 0o775:
                    raise ScopeError('SOCKET_BASELINE_UNEXPECTED')
                _no_acl(path)
                fd = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
                self.fds[role] = fd
                if stamp(os.fstat(fd)) != stamp(prior) or stamp(os.lstat(path)) != stamp(prior):
                    raise ScopeError('SOCKET_IDENTITY_CHANGED')
                self.before[role] = stamp(prior)
        except BaseException:
            self.close()
            raise

    def _assert(self, role, expected):
        path, fd = ENDPOINTS[role], self.fds[role]
        _safe_parents(path)
        _no_acl(path)
        if stamp(os.lstat(path)) != expected or stamp(os.fstat(fd)) != expected:
            raise ScopeError('SOCKET_IDENTITY_CHANGED')

    def restrict(self):
        if self.state != 'initial':
            raise ScopeError('RESTRICTION_REPLAY_FORBIDDEN')
        self.state = 'unknown'
        for role in ('pub', 'rpc'):
            prior = self.before[role]
            self._assert(role, prior)
            self.checkpoint('restrict-intent', role, prior)
            self._assert(role, prior)
            os.chmod('/proc/self/fd/%d' % self.fds[role], 0o600)
            after = stamp(os.fstat(self.fds[role]))
            if after[0:2] != prior[0:2] or stat.S_IMODE(after[2]) != 0o600 or after[3:5] != (0, 0):
                raise ScopeError('RESTRICTION_RESULT_UNKNOWN')
            self._assert(role, after)
            self.checkpoint('restrict-applied', role, after)
            self.after[role] = after
        self.state = 'restricted'

    def restore(self):
        if self.state != 'restricted':
            raise ScopeError('RESTORE_REPLAY_FORBIDDEN')
        self.state = 'unknown'
        for role in ('rpc', 'pub'):
            after, prior = self.after[role], self.before[role]
            self._assert(role, after)
            self.checkpoint('restore-intent', role, after)
            self._assert(role, after)
            os.chmod('/proc/self/fd/%d' % self.fds[role], stat.S_IMODE(prior[2]))
            restored = stamp(os.fstat(self.fds[role]))
            if restored[0:2] != prior[0:2] or restored[2:5] != prior[2:5]:
                raise ScopeError('RESTORE_RESULT_UNKNOWN')
            self._assert(role, restored)
            self.checkpoint('restore-applied', role, restored)
        self.state = 'restored'

    def close(self):
        for fd in self.fds.values():
            os.close(fd)
        self.fds.clear()


def inspect_rpc_peers(daemon_pid, daemon_start):
    """Kernel+proc snapshots; returns observations, never an exclusivity proof."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ScopeError('LINUX_ROOT_REQUIRED')
    d = load_diag()
    reader = d.Reads()

    def daemon():
        _, start = d.proc_stat(reader.read('/proc/%d/stat' % daemon_pid, 8192))
        if start != daemon_start or d.uids(reader.read('/proc/%d/status' % daemon_pid, 65536)) != (0, 0, 0, 0):
            raise ScopeError('DAEMON_IDENTITY_CHANGED')
        command = reader.read('/proc/%d/cmdline' % daemon_pid, 65536).rstrip(b'\0')
        if command != b'fixture-only-daemon':
            raise ScopeError('DAEMON_IDENTITY_CHANGED')
        return d.namespace(reader, daemon_pid)

    ownns = d.namespace(reader, os.getpid())
    if daemon() != ownns:
        raise ScopeError('DAEMON_NAMESPACE_MISMATCH')
    with d.Metadata() as metadata:
        for role, path in ENDPOINTS.items():
            meta = os.lstat(path)
            if not metadata.rows[role]['access_acl_absent'] or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_uid != 0 or meta.st_gid != 0:
                raise ScopeError('SOCKET_RESTRICTION_MISSING')
        table = '/proc/%d/net/unix' % os.getpid()
        before = d.endpoint_rows(reader.read(table, 2097152))
        first = d.kernel_dump(0x61e91001)
        servers, peers = d.associated(first)
        targets = {**before, 'diag_peer_inodes': {i: (0, 3) for i in servers | peers}}
        counts, holders, people = d.scan(reader, targets, ownns)
        second = d.kernel_dump(0x61e91002)
        after = d.endpoint_rows(reader.read(table, 2097152))
        if daemon() != ownns or before != after:
            raise ScopeError('PEER_SNAPSHOT_DRIFT')
        metadata.verify()
        if any(counts[k] for k in ('process_races', 'fd_races', 'inaccessible_processes', 'unknown_namespaces', 'net_namespace_other')):
            raise ScopeError('PEER_SCAN_INCOMPLETE')
        endpoint = next(x for x in d.aggregate(before, holders, people, daemon_pid, ownns, metadata.rows) if x['role'] == 'rpc')
        if not endpoint['listener_unique'] or not endpoint['listener_held_by_bound_daemon']:
            raise ScopeError('RPC_LISTENER_OWNER_UNCERTAIN')
        if endpoint['connected_rows'] and not endpoint['connected_rows_all_held_by_bound_daemon']:
            raise ScopeError('RPC_SERVER_HOLDER_UNCERTAIN')
        summaries = d.diag_summary(first, second, before, holders, people, ownns)
        item = next(x for x in summaries if x['role'] == 'rpc')
        if not all(item[k] for k in ('endpoint_set_matches_proc', 'related_snapshot_stable', 'pending_measured', 'pending_consistent')):
            raise ScopeError('RPC_SOCKET_SNAPSHOT_UNCERTAIN')
        if item['pending_connections'] or item['pending_peer_icons']:
            raise ScopeError('RPC_PENDING_CONNECTION')
        if item['connected_server_records'] != item['stable_peer_edges'] or item['peer_inodes_without_observed_holder']:
            raise ScopeError('RPC_PEER_UNATTRIBUTED')
        if any(item[k] for k in ('peer_holder_nonroot_euid', 'peer_holder_nonroot_fsuid', 'peer_holder_foreign_user_ns', 'peer_holder_foreign_net_ns', 'peer_holder_foreign_mount_ns', 'peer_holder_unknown_namespace', 'peer_socket_uid_nonroot', 'peer_socket_uid_unknown')):
            raise ScopeError('RPC_PEER_IDENTITY_UNCERTAIN')
        selected = [r for r in first.values() if r['kind'] == 1 and r['name'] == d.ENDPOINTS['rpc'] and r['state'] == 1]
        peer_pids = set()
        for row in selected:
            peer_pids.update(holders.get(row['peer'], set()))
        # Current holders are observations, not SO_PEERCRED, durable session
        # identities or permission to interrupt/restart a peer.
        identities = []
        for pid in sorted(peer_pids):
            first_stat = d.proc_stat(reader.read('/proc/%d/stat' % pid, 8192))
            if d.uids(reader.read('/proc/%d/status' % pid, 65536)) != (0, 0, 0, 0):
                raise ScopeError('RPC_PEER_IDENTITY_UNCERTAIN')
            if d.proc_stat(reader.read('/proc/%d/stat' % pid, 8192)) != first_stat:
                raise ScopeError('RPC_PEER_IDENTITY_CHANGED')
            identities.append((pid, first_stat[1]))
        return {'current_holders': tuple(identities),
                'connected_count': len(selected), 'exclusivity_proven': False}
