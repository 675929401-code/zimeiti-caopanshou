"""Synthetic Linux fixture child, never installed as production helper."""
import hashlib
import os
import sys
from pathlib import Path

if sys.platform!='linux' or os.geteuid()!=0 or not Path('/.dockerenv').exists() or set(os.listdir('/sys/class/net'))!={'lo'}:
    raise SystemExit('fixture isolation required')
sys.path.insert(0,'/fixture')
import file_txn as files
import journal_owner as journal
import nginx_lifecycle as nginx
import session_protocol as protocol
import version_acceptance as version

TX='release1-abcdef123456'
if sys.argv!=[sys.argv[0],'--session',TX]:raise SystemExit('fixture args')
ROOT=Path('/root/nginx-owned-fixture')
LIVE=ROOT/'live';BASE=ROOT/'transactions';JOURNAL=BASE/TX
files.LIVE=str(LIVE);files.JOURNAL_BASE=str(BASE);journal.JOURNAL_BASE=str(BASE)
old={k:(LIVE/(k+'.conf')).read_bytes() for k in ('hub','target')}
files.FILES={k:(k+'.conf',hashlib.sha256(v).hexdigest()) for k,v in old.items()}
protocol.SOURCE=[files.FILES[k][1] for k in ('hub','target')]
tag=hashlib.sha256(TX.encode()).hexdigest()[:32]
candidates={k:version.fixture_preview(k,old[k],tag)['candidate'] for k in ('hub','target')}
plan={'transactionId':TX,'candidates':candidates,'identities':{k:{'original_sha256':files.FILES[k][1],
      'candidate_sha256':hashlib.sha256(candidates[k]).hexdigest()} for k in ('hub','target')},
      'deployment_allowed':False,'nginx_effective_proven':False}
nginx.EXE='/usr/sbin/nginx';nginx.EXE_SHA=hashlib.sha256(Path(nginx.EXE).read_bytes()).hexdigest()
nginx.MAIN=str(ROOT/'nginx.conf');nginx.MAIN_SHA=hashlib.sha256(Path(nginx.MAIN).read_bytes()).hexdigest()


class FixtureGuard:
    def __init__(self):self.parent=os.getppid()
    def assert_live(self):
        if os.getppid()!=self.parent:raise RuntimeError('fixture parent lost')
    def assert_exclusive_config_writer(self):self.assert_live()
    def assert_candidate_prevalidated(self):self.assert_live()
    def assert_install_allowed(self):self.assert_live()
    def assert_restore_allowed(self):self.assert_live()


lfd=os.open(LIVE,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
jfd=os.open(JOURNAL,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
owner=journal.JournalOwner(FixtureGuard(),jfd,TX,plan)
txn=files.FileTransaction(owner,lfd,jfd,tag,candidates)
life=nginx.Lifecycle(owner,txn)
if (ROOT/'simulate-lost-ack').exists():
    class LostAcknowledgement:
        def install(self):
            life.install()
            os._exit(73)  # fixture child only: mutation completed, reply lost
        def verify(self):return life.verify()
        def restore(self):return life.restore()
    session_life=LostAcknowledgement()
else:session_life=life
try:
    result=protocol.serve(owner,session_life,plan,sys.stdin.buffer,sys.stdout.buffer)
    if result!='RESTORED_FILES_ONLY':raise SystemExit(2)
finally:
    life.close();owner.close();os.close(lfd);os.close(jfd)
