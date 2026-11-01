"""Isolated Linux kernel socket fixture, never connects to a real PM2 daemon."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import time
import unittest

if os.name != 'posix' or not hasattr(socket, 'SO_PEERCRED') or os.geteuid() != 0:
    raise SystemExit('Linux root isolated fixture required')
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('live_drain', HERE / 'live_drain.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


class FixtureFrames:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, raw):
        self.buffer.extend(raw)
        out = []
        while self.buffer:
            if self.buffer[0] != 0x12:
                raise ValueError('fixture frame')
            pos = 1
            parts = []
            for _ in range(2):
                if len(self.buffer) < pos + 4:
                    return out
                size = int.from_bytes(self.buffer[pos:pos+4], 'big')
                pos += 4
                if size > 1048576:
                    raise ValueError('fixture frame limit')
                if len(self.buffer) < pos + size:
                    return out
                parts.append(bytes(self.buffer[pos:pos+size]))
                pos += size
            out.append(parts)
            del self.buffer[:pos]
        return out


class FixtureProbe:
    Frames = FixtureFrames
    parse_json = staticmethod(json.loads)


def frame(parts):
    return bytes([16 | len(parts)]) + b''.join(len(x).to_bytes(4, 'big') + x for x in parts)


class KernelRpcFixture(unittest.TestCase):
    def test_one_shot_existing_peer_and_no_reconnect(self):
        with tempfile.TemporaryDirectory(prefix='pm2-rpc-fixture-') as tmp:
            os.chmod(tmp, 0o700)
            sock_path = str(Path(tmp) / 'rpc.sock')
            reader, writer = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(reader)
                server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                server.bind(sock_path)
                os.chmod(sock_path, 0o600)
                server.listen(1)
                os.write(writer, b'1')
                os.close(writer)
                client, _ = server.accept()
                client.settimeout(5)
                parser = FixtureFrames()
                found = []
                while not found:
                    found += parser.feed(client.recv(65536))
                parts = found[0]
                value = json.loads(parts[0][2:])
                if value != {'type': 'call', 'method': 'stopProcessId', 'args': [1001]}:
                    os._exit(31)
                result = {'args': [{'pid': 0, 'name': 'agent-hub-media-worker', 'pm_id': 1001,
                                     'pm2_env': {'pm_id': 1001, 'status': 'stopped'}}]}
                encoded = b'j:' + json.dumps(result, separators=(',', ':')).encode()
                client.sendall(frame([encoded, parts[1]]))
                client.close()
                server.close()
                os._exit(0)
            os.close(writer)
            self.assertEqual(os.read(reader, 1), b'1')
            os.close(reader)
            old_path = live.RPC_PATH
            live.RPC_PATH = sock_path
            receiver = live.LinuxContinuousDrain.__new__(live.LinuxContinuousDrain)
            receiver.binding = {'daemon': pid}
            receiver.probe = FixtureProbe()
            receiver.rpc_sock = None
            receiver._assert_daemon = lambda: None
            try:
                request = receiver._pm2_command(1001)
                deadline = time.monotonic() + 5
                while request.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(request.returncode, 0)
                self.assertEqual(os.waitpid(pid, 0)[1], 0)
            finally:
                live.RPC_PATH = old_path
                if receiver.rpc_sock is not None:
                    receiver.rpc_sock.close()

    def test_wrong_daemon_peer_gets_no_request(self):
        with tempfile.TemporaryDirectory(prefix='pm2-rpc-fixture-') as tmp:
            os.chmod(tmp, 0o700)
            sock_path = str(Path(tmp) / 'rpc.sock')
            reader, writer = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(reader)
                server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                server.bind(sock_path)
                os.chmod(sock_path, 0o600)
                server.listen(1)
                os.write(writer, b'1')
                os.close(writer)
                client, _ = server.accept()
                client.settimeout(5)
                data = client.recv(1024)
                client.close()
                server.close()
                os._exit(0 if data == b'' else 32)
            os.close(writer)
            self.assertEqual(os.read(reader, 1), b'1')
            os.close(reader)
            old_path = live.RPC_PATH
            live.RPC_PATH = sock_path
            receiver = live.LinuxContinuousDrain.__new__(live.LinuxContinuousDrain)
            receiver.binding = {'daemon': pid + 1}
            receiver.probe = FixtureProbe()
            receiver.rpc_sock = None
            receiver._assert_daemon = lambda: None
            try:
                with self.assertRaisesRegex(live.DrainError, 'RPC_PEER_MISMATCH'):
                    receiver._pm2_command(1001)
                self.assertEqual(os.waitpid(pid, 0)[1], 0)
            finally:
                live.RPC_PATH = old_path
                if receiver.rpc_sock is not None:
                    receiver.rpc_sock.close()


if __name__ == '__main__':
    unittest.main()
