"""Bounded, one-shot wire codec for an already connected PM2 RPC socket.

The caller owns socket creation, SO_PEERCRED verification, ingress exclusion,
PM2 identity and the durable write-ahead journal. This module never launches a
daemon or reconnects. It does not confer deployment eligibility.
"""
import json


class RpcError(Exception):
    pass


def encode_stop(pmid, request_id):
    if type(pmid) is not int or pmid not in (18, 19):
        raise RpcError('RPC_ID_INVALID')
    if not isinstance(request_id, str) or not request_id.isascii() or not request_id.isdecimal() or len(request_id) > 20:
        raise RpcError('RPC_REQUEST_ID_INVALID')
    payload = json.dumps({'type': 'call', 'method': 'stopProcessId', 'args': [pmid]},
                         ensure_ascii=True, separators=(',', ':')).encode('ascii')
    parts = (b'j:' + payload, b's:' + request_id.encode('ascii'))
    return bytes([0x10 | len(parts)]) + b''.join(len(x).to_bytes(4, 'big') + x for x in parts)


class StopReply:
    def __init__(self, pmid, request_id, frames, parse_json):
        self.pmid = pmid
        self.request_id = request_id
        self.frames = frames
        self.parse_json = parse_json
        self.completed = False

    def feed(self, data):
        if self.completed:
            raise RpcError('RPC_REPLY_REPLAY')
        for frame in self.frames.feed(data):
            if self.completed:
                raise RpcError('RPC_REPLY_REPLAY')
            if len(frame) != 2 or frame[1] != b's:' + self.request_id.encode('ascii') or not frame[0].startswith(b'j:'):
                raise RpcError('RPC_REPLY_IDENTITY_INVALID')
            try:
                reply = self.parse_json(frame[0][2:])
            except (ValueError, RecursionError, UnicodeError):
                raise RpcError('RPC_REPLY_JSON_INVALID') from None
            if type(reply) is not dict or 'error' in reply or type(reply.get('args')) is not list or len(reply['args']) != 1:
                raise RpcError('RPC_REPLY_FAILED')
            value = reply['args'][0]
            if type(value) is not dict or value.get('error') is True or type(value.get('pm2_env')) is not dict:
                raise RpcError('RPC_RESULT_INVALID')
            env = value['pm2_env']
            if (value.get('name') != 'agent-hub-media-worker' or value.get('pm_id') != self.pmid
                    or env.get('pm_id') != self.pmid or env.get('status') != 'stopped' or value.get('pid') != 0):
                raise RpcError('RPC_RESULT_IDENTITY_INVALID')
            self.completed = True
        if self.completed and self.frames.buffer:
            raise RpcError('RPC_REPLY_TRAILING_DATA')
        return self.completed
