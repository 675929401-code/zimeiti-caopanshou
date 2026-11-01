"""Fixed PM2 read-only slot observer for an authenticated release session.

No factory in this module authorizes production. getMonitorData returns full
PM2 environment in memory; only the four sanitized slot fields escape. A fixed
peer/daemon plus unchanged slots is not an atomic compare-and-stop: owner must
independently exclude other controllers and bind activity/maintenance evidence.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import sys
import time

WORK = Path(__file__).resolve().parent.parent
WATCH_FILE = WORK / 'linux-owner-implementation-61e9/worker-provider/continuous_watch.py'
WATCH_SHA = '767b82c7d40adbe8047ce6cfb4f968cdeae73420d47e8c481b10eae861324c8f'
RPC_PATH = '/root/.pm2/rpc.sock'
IDS = (18, 19)


class SlotError(RuntimeError): pass


def _fail(code): raise SlotError(code)


def parse_slots(processes):
    if type(processes) is not list or len(processes) > 4096: _fail('SLOT_MONITOR_INVALID')
    slots = {}
    for item in processes:
        if type(item) is not dict: _fail('SLOT_MONITOR_INVALID')
        if item.get('name') != 'agent-hub-media-worker': continue
        env = item.get('pm2_env')
        if type(env) is not dict: _fail('SLOT_MONITOR_INVALID')
        pmid, pid, unique, status = item.get('pm_id'), item.get('pid'), env.get('unique_id'), env.get('status')
        if (type(pmid) is not int or pmid not in IDS or env.get('pm_id') != pmid or
                type(pid) is not int or pid < 0 or type(unique) is not str or
                not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', unique) or status not in ('online', 'stopped') or
                (status == 'online' and pid <= 1) or (status == 'stopped' and pid != 0) or pmid in slots):
            _fail('SLOT_MONITOR_INVALID')
        slots[pmid] = {'pm_id': pmid, 'pid': pid, 'unique_id': unique, 'status': status}
    if set(slots) != set(IDS):
        _fail('SLOT_MONITOR_INVALID')
    return slots


def _request(number):
    if type(number) is not int or not 1 <= number <= 99999999: _fail('SLOT_REQUEST_LIMIT')
    data = json.dumps({'type':'call', 'method':'getMonitorData', 'args':[{}]},
                      ensure_ascii=True, separators=(',', ':')).encode('ascii')
    parts = (b'j:' + data, b's:' + str(number).encode('ascii'))
    return bytes([0x12]) + b''.join(len(part).to_bytes(4, 'big') + part for part in parts)


class LinuxMonitorRpc:
    """Read-only fixed method, fixed daemon peer, one persistent socket."""
    def __init__(self, inner, timeout=5):
        if sys.platform != 'linux' or os.geteuid() != 0 or type(timeout) not in (int,float) or not 0 < timeout <= 10:
            _fail('SLOT_LINUX_OWNER_REQUIRED')
        self.inner, self.timeout, self.counter, self.poisoned = inner, timeout, 0, False
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            inner._assert_daemon(); self.sock.settimeout(timeout); self.sock.connect(RPC_PATH)
            peer = struct.unpack('3i', self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer[0] != inner.binding['daemon'] or peer[1] != 0: _fail('SLOT_RPC_PEER_INVALID')
            inner._assert_daemon()
        except BaseException:
            self.sock.close(); raise

    def monitor(self):
        if self.poisoned: _fail('SLOT_RPC_POISONED')
        self.counter += 1
        try:
            self.inner._assert_daemon()
            # sendall may fail after a partial frame. This is read-only but the
            # session is still poisoned; do not reconnect automatically.
            self.sock.settimeout(self.timeout); self.sock.sendall(_request(self.counter))
            deadline = time.monotonic() + self.timeout
            frames = self.inner.probe.Frames()
            while time.monotonic() < deadline:
                self.sock.settimeout(max(0.001, deadline - time.monotonic()))
                raw = self.sock.recv(65536)
                if not raw: _fail('SLOT_RPC_DISCONNECTED')
                values = frames.feed(raw)
                if not values: continue
                if (len(values) != 1 or len(values[0]) != 2 or frames.buffer or
                        values[0][1] != b's:' + str(self.counter).encode('ascii') or
                        not values[0][0].startswith(b'j:')): _fail('SLOT_RPC_REPLY_INVALID')
                reply = self.inner.probe.parse_json(values[0][0][2:])
                if (type(reply) is not dict or 'error' in reply or type(reply.get('args')) is not list or
                        len(reply['args']) != 1): _fail('SLOT_RPC_REPLY_INVALID')
                self.inner._assert_daemon()
                return parse_slots(reply['args'][0])
            _fail('SLOT_RPC_DEADLINE')
        except BaseException:
            self.poisoned = True
            raise

    def close(self): self.sock.close()


class FixedSlotMonitor:
    """Same watch/owner slot callable for exact_stop; no release authority."""
    def __init__(self, owner, watch, watch_module):
        # The final authenticated owner must use the identical loaded module
        # object for exact_stop and this observer. The hash alone cannot prove
        # imported code did not drift; seal the full runtime closure first.
        if (hashlib.sha256(WATCH_FILE.read_bytes()).hexdigest() != WATCH_SHA or
                Path(getattr(watch_module, '__file__', '')).resolve() != WATCH_FILE.resolve()):
            _fail('SLOT_SOURCE_CHANGED')
        if (type(watch) is not watch_module._ContinuousWatch or
                type(watch.runtime) is not watch_module.LinuxRuntime or watch.owner is not owner):
            _fail('SLOT_OWNER_NOT_BOUND')
        owner.assert_live()
        self.owner, self.watch = owner, watch
        self.rpc = LinuxMonitorRpc(watch.runtime.inner)
        self.poisoned, self.closed, self.unique = False, False, None

    def slot(self, pmid):
        if self.poisoned or self.closed or type(pmid) is not int or pmid not in IDS:
            _fail('SLOT_MONITOR_UNAVAILABLE')
        with self.watch._mutex:
            try:
                self.watch._check(); self.watch._sample()
                slots = self.rpc.monitor()
                current_unique = {i: slots[i]['unique_id'] for i in IDS}
                if self.unique is None:
                    if any(slots[i]['status'] != 'online' for i in IDS): _fail('SLOT_INITIAL_NOT_ONLINE')
                    self.unique = current_unique
                elif self.unique != current_unique:
                    _fail('SLOT_GENERATION_CHANGED')
                expected = {value[2]: value for value in self.watch.baseline}
                for key, row in slots.items():
                    pid, start, _ = expected[key]
                    if row['status'] == 'online':
                        if (row['pid'] != pid or key in self.watch._observations or
                                self.watch.runtime.probe.proc_fields(pid)[1] != start):
                            _fail('SLOT_GENERATION_CHANGED')
                    elif key not in self.watch._intents:
                        _fail('SLOT_STOP_WITHOUT_INTENT')
                self.watch._check(); self.watch._sample()
                result = dict(slots[pmid])
                if result['status'] == 'online': result['start_ticks'] = expected[pmid][1]
                return result
            except BaseException:
                self.poisoned = True
                try: self.watch._poison('SLOT_OBSERVATION_UNKNOWN', asynchronous=True)
                except BaseException: pass
                raise

    def close(self):
        if not self.closed:
            self.closed = True
            self.rpc.close()


def open_production_slot_monitor(*_args, **_kwargs):
    _fail('SLOT_AUTHENTICATED_OWNER_NOT_CONNECTED')


if __name__ == '__main__': raise SystemExit('DISABLED: no standalone worker executor')
