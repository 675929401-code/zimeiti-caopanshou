"""Single-session NDJSON bridge for a sealed parent; no standalone entry.

The creator must authenticate its parent, bind the trusted control plane,
construct the real owner/lifecycle and hold both pipes for the whole window.
This protocol does not turn caller-provided booleans into production evidence.
"""
import hashlib
import json
import re
import select

SOURCE = ['0'*64,'1'*64]
MAX_LINE=1024


class Refuse(RuntimeError):pass


def _pairs(items):
    out={}
    for key,value in items:
        if key in out:raise Refuse('DUPLICATE')
        out[key]=value
    return out


def _read(reader):
    line=reader.readline(MAX_LINE+1)
    if not line:return None
    if len(line)>MAX_LINE or not line.endswith(b'\n'):raise Refuse('FRAME')
    try:value=json.loads(line,object_pairs_hook=_pairs)
    except (ValueError,UnicodeError,RecursionError):raise Refuse('FRAME') from None
    if type(value) is not dict or list(value)!=['seq','transactionId','op']:raise Refuse('FRAME')
    canonical=(json.dumps(value,separators=(',',':'),ensure_ascii=True)+'\n').encode('ascii')
    if line!=canonical:raise Refuse('FRAME')
    return value


def _send(writer,value):
    data=(json.dumps(value,separators=(',',':'),ensure_ascii=True)+'\n').encode('ascii')
    if len(data)>MAX_LINE:raise Refuse('FRAME')
    if writer.write(data)!=len(data):raise Refuse('SHORT_WRITE')
    writer.flush()


def _wait_parent_eof(reader,timeout=10):
    try:fd=reader.fileno()
    except (AttributeError,ValueError,OSError):fd=None
    if fd is not None:
        ready,_,_=select.select([fd],[],[],timeout)
        if not ready:raise Refuse('CLOSE_TIMEOUT')
    if reader.read(1)!=b'':raise Refuse('TRAILING_INPUT')


def serve(owner,lifecycle,plan,reader,writer):
    """Returns only after restore, EOF, or UNKNOWN; never retries an action."""
    tx=plan.get('transactionId')
    if not isinstance(tx,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}',tx):raise Refuse('TRANSACTION')
    identities=plan.get('identities');candidates=plan.get('candidates')
    if type(identities) is not dict or set(identities)!={'hub','target'} or type(candidates) is not dict or set(candidates)!={'hub','target'}:raise Refuse('PLAN')
    source=[identities[k].get('original_sha256') for k in ('hub','target')]
    candidate=[identities[k].get('candidate_sha256') for k in ('hub','target')]
    if source!=SOURCE or any(not isinstance(x,str) or not re.fullmatch('[a-f0-9]{64}',x) for x in candidate):raise Refuse('PLAN')
    if any(type(candidates[k]) is not bytes or hashlib.sha256(candidates[k]).hexdigest()!=identities[k]['candidate_sha256'] for k in ('hub','target')):raise Refuse('PLAN')
    if plan.get('deployment_allowed') is not False or plan.get('nginx_effective_proven') is not False:raise Refuse('PLAN')
    def reply(seq,op,outcome):
        _send(writer,{'seq':seq,'transactionId':tx,'op':op,'outcome':outcome,'sourceSha256':source,'candidateSha256':candidate})
    owner.assert_live();reply(0,'ready','READY')
    for seq,op in enumerate(('install','verify','restore'),1):
        try:
            owner.assert_live();request=_read(reader)
            if request is None:owner.mark_unknown();return 'UNKNOWN'
            if type(request['seq']) is not int or request['seq']!=seq or request['transactionId']!=tx or request['op']!=op:raise Refuse('ORDER')
            result=getattr(lifecycle,op)()
            if type(result) is not dict:raise Refuse('RESULT')
            expected='RESTORED_FILES_ONLY' if op=='restore' else 'HELD_FILES_ONLY'
            if result.get('outcome')!=expected:raise Refuse('RESULT')
            owner.assert_live();reply(seq,op,expected)
        except Exception:
            owner.mark_unknown()
            try:reply(seq,op,'UNKNOWN')
            except Exception:pass
            return 'UNKNOWN'
    try:
        _wait_parent_eof(reader)
        owner.assert_live()
    except Exception:
        owner.mark_unknown();return 'UNKNOWN'
    return 'RESTORED_FILES_ONLY'


if __name__=='__main__':print('DISABLED: sealed parent integration not installed')
