"""Creates only temporary synthetic sockets beneath a private root directory."""
import importlib.util
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import unittest

if sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('Linux root isolated fixture required')
here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('scope', here / 'socket_scope.py')
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='scope-synthetic-', dir='/root')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.saved = scope.ENDPOINTS
        scope.ENDPOINTS = {role: str(self.root / (role + '.sock')) for role in ('pub', 'rpc')}
        self.addCleanup(setattr, scope, 'ENDPOINTS', self.saved)
        self.sockets = {}
        for role, path in scope.ENDPOINTS.items():
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(3)
            os.chmod(path, 0o775)
            self.sockets[role] = server
            self.addCleanup(server.close)
        self.log = []

    def mode(self, role):
        return stat.S_IMODE(os.lstat(scope.ENDPOINTS[role]).st_mode)

    def test_restrict_restore_existing_peer_survives(self):
        peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(peer.close)
        peer.connect(scope.ENDPOINTS['rpc'])
        accepted, _ = self.sockets['rpc'].accept()
        self.addCleanup(accepted.close)
        guard = scope.SocketScope(lambda *args: self.log.append(args))
        self.addCleanup(guard.close)
        guard.restrict()
        self.assertEqual((self.mode('pub'), self.mode('rpc')), (0o600, 0o600))
        accepted.sendall(b'ok')
        self.assertEqual(peer.recv(2), b'ok')
        guard.restore()
        self.assertEqual((self.mode('pub'), self.mode('rpc')), (0o775, 0o775))
        self.assertEqual([e[0] for e in self.log], ['restrict-intent', 'restrict-applied', 'restrict-intent',
                         'restrict-applied', 'restore-intent', 'restore-applied', 'restore-intent', 'restore-applied'])

    def test_changed_mode_rejects_restore_without_overwrite(self):
        guard = scope.SocketScope(lambda *args: self.log.append(args))
        self.addCleanup(guard.close)
        guard.restrict()
        os.chmod(scope.ENDPOINTS['rpc'], 0o640)
        with self.assertRaisesRegex(scope.ScopeError, 'SOCKET_IDENTITY_CHANGED'):
            guard.restore()
        self.assertEqual(self.mode('rpc'), 0o640)
        self.assertEqual(guard.state, 'unknown')
        with self.assertRaisesRegex(scope.ScopeError, 'REPLAY'):
            guard.restore()

    def test_checkpoint_failure_does_not_automatically_restore(self):
        def checkpoint(stage, role, value):
            self.log.append((stage, role, value))
            if stage == 'restrict-applied' and role == 'pub':
                raise OSError('synthetic journal failure')
        guard = scope.SocketScope(checkpoint)
        self.addCleanup(guard.close)
        with self.assertRaises(OSError):
            guard.restrict()
        self.assertEqual((self.mode('pub'), self.mode('rpc')), (0o600, 0o775))
        self.assertEqual(guard.state, 'unknown')
        with self.assertRaisesRegex(scope.ScopeError, 'REPLAY'):
            guard.restore()


if __name__ == '__main__':
    unittest.main()
