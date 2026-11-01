"""Standalone Linux test; only temporary fixture paths, never production."""
import hashlib
import json
import os
import stat
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import file_txn_exchange as f


class Owner:
    def __init__(self,root,fail=None):self.pid=os.getpid();self.root=root;self.fail=fail
    def assert_live(self):
        if os.getpid()!=self.pid:raise RuntimeError('owner lost')
    def assert_candidate_prevalidated(self,_):self.assert_live()
    def assert_restore_allowed(self):self.assert_live()
    def assert_exclusive_config_writer(self):self.assert_live()  # synthetic fixture only
    def assert_staging_not_included(self):self.assert_live()  # synthetic fixture only
    def checkpoint(self,phase,details):
        self.assert_live()
        path=self.root/'events.jsonl'
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
        try:os.write(fd,(json.dumps({'phase':phase,'details':details})+'\n').encode());os.fsync(fd)
        finally:os.close(fd)
        if phase==self.fail:raise RuntimeError('injected')


class LinuxTests(unittest.TestCase):
    def setUp(self):
        if os.name!='posix' or not hasattr(os,'geteuid'):
            self.skipTest('Linux only')
        if os.geteuid()!=0 or os.readlink('/proc/self/ns/net')==os.readlink('/proc/1/ns/net'):
            raise RuntimeError('requires root in isolated network namespace')
        self.temp=tempfile.TemporaryDirectory(prefix='nginx-hold-fixture-',dir='/root');self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name);self.live=root/'live';self.base=root/'transactions';self.journal=self.base/'release1-abcdef123456'
        self.live.mkdir(mode=0o700);self.base.mkdir(mode=0o700);self.journal.mkdir(mode=0o700)
        self.old={'hub':b'fixture old hub','target':b'fixture old target'};self.new={'hub':b'fixture hold hub','target':b'fixture hold target'}
        for k,data in self.old.items():(self.live/(k+'.conf')).write_bytes(data)
        self.saved_live,self.saved_base,self.saved_files=f.LIVE,f.JOURNAL_BASE,f.FILES
        f.LIVE=str(self.live);f.JOURNAL_BASE=str(self.base);f.FILES={k:(k+'.conf',f.digest(v)) for k,v in self.old.items()}
        self.addCleanup(self.reset)
        self.livefd=os.open(self.live,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);self.journalfd=os.open(self.journal,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        self.addCleanup(os.close,self.livefd);self.addCleanup(os.close,self.journalfd)
    def reset(self):f.LIVE=self.saved_live;f.JOURNAL_BASE=self.saved_base;f.FILES=self.saved_files
    def tx(self,fail=None):
        tag=hashlib.sha256(self.journal.name.encode()).hexdigest()[:32]
        return f.FileTransaction(Owner(self.journal,fail),self.livefd,self.journalfd,tag,self.new)
    def test_real_stage_install_verify_restore(self):
        tx=self.tx();tx.stage();tx.install();tx.verify_files()
        for k in self.new:self.assertEqual((self.live/(k+'.conf')).read_bytes(),self.new[k])
        tx.restore();self.assertEqual(tx.state,'RESTORED')
        for k in self.old:self.assertEqual((self.live/(k+'.conf')).read_bytes(),self.old[k])
        self.assertEqual(stat.S_IMODE((self.journal/'hub.original').stat().st_mode),0o600)
        events=[json.loads(line) for line in (self.journal/'events.jsonl').read_text().splitlines()]
        staged=next(e for e in events if e['phase']=='file-stage-one')
        installed=next(e for e in events if e['phase']=='file-install-one')
        self.assertEqual(len(staged['details']['original_identity']),9)
        self.assertEqual(len(staged['details']['backup_identity']),9)
        self.assertEqual(len(staged['details']['staged_identity']),9)
        self.assertEqual(len(installed['details']['installed_identity']),9)
    def test_partial_result_is_unknown_without_auto_recovery(self):
        tx=self.tx('file-install-one');tx.stage()
        with self.assertRaises(RuntimeError):tx.install()
        self.assertEqual(tx.state,'UNKNOWN')
        with self.assertRaises(f.Refuse):tx.restore()
        self.assertEqual((self.live/'hub.conf').read_bytes(),self.new['hub'])
        self.assertEqual((self.live/tx.originals['hub']['temp']).read_bytes(),self.old['hub'])
        self.assertEqual((self.live/'target.conf').read_bytes(),self.old['target'])
    def test_external_change_rejected_before_restore(self):
        tx=self.tx();tx.stage();tx.install()
        (self.live/'hub.conf').write_bytes(b'external change')
        with self.assertRaises(f.Refuse):tx.restore()
        self.assertEqual((self.live/'hub.conf').read_bytes(),b'external change')
        self.assertEqual(tx.state,'UNKNOWN')
    def test_extended_attribute_or_acl_fails_closed(self):
        os.setxattr(self.live/'hub.conf','user.fixture',b'1')
        tx=self.tx()
        with self.assertRaises(f.Refuse):tx.stage()
        self.assertEqual(tx.state,'UNKNOWN')
        self.assertEqual((self.live/'hub.conf').read_bytes(),self.old['hub'])
    def test_symlink_source_fails_closed(self):
        path=self.live/'hub.conf';path.unlink();path.symlink_to(self.live/'target.conf')
        tx=self.tx()
        with self.assertRaises((f.Refuse,OSError)):tx.stage()
        self.assertEqual(tx.state,'UNKNOWN')
    def test_replaced_journal_path_refused_before_live_replacement(self):
        tx=self.tx();tx.stage()
        self.journal.rename(self.base/'journal-moved');self.journal.mkdir(mode=0o700)
        with self.assertRaises(f.Refuse):tx.install()
        self.assertEqual(tx.state,'UNKNOWN')
        for k in self.old:self.assertEqual((self.live/(k+'.conf')).read_bytes(),self.old[k])
    def test_install_race_preserves_changed_original_and_enters_unknown(self):
        tx=self.tx();tx.stage();real=f._exchange
        def race(fd,live,stage):
            (self.live/live).write_bytes(b'concurrent admin change')
            return real(fd,live,stage)
        with patch.object(f,'_exchange',side_effect=race):
            with self.assertRaises(f.Refuse):tx.install()
        self.assertEqual(tx.state,'UNKNOWN')
        self.assertEqual((self.live/'hub.conf').read_bytes(),self.new['hub'])
        self.assertEqual((self.live/tx.originals['hub']['temp']).read_bytes(),b'concurrent admin change')
        with self.assertRaises(f.Refuse):tx.restore()
    def test_restore_race_preserves_changed_gate_and_enters_unknown(self):
        tx=self.tx();tx.stage();tx.install();real=f._exchange
        def race(fd,live,stage):
            (self.live/live).write_bytes(b'concurrent gate edit')
            return real(fd,live,stage)
        with patch.object(f,'_exchange',side_effect=race):
            with self.assertRaises(f.Refuse):tx.restore()
        self.assertEqual(tx.state,'UNKNOWN')
        self.assertEqual((self.live/'hub.conf').read_bytes(),self.old['hub'])
        self.assertEqual((self.live/f'.codex-hold-{tx.tx}-hub.restore').read_bytes(),b'concurrent gate edit')
    def test_process_crash_immediately_after_exchange_keeps_both_names(self):
        pid=os.fork()
        if pid==0:
            try:
                tx=self.tx();tx.stage();real=f._exchange
                def crash(fd,live,stage):
                    real(fd,live,stage);os._exit(73)
                with patch.object(f,'_exchange',side_effect=crash):tx.install()
            except BaseException:os._exit(70)
            os._exit(71)
        _,status=os.waitpid(pid,0)
        self.assertTrue(os.WIFEXITED(status));self.assertEqual(os.WEXITSTATUS(status),73)
        tag=hashlib.sha256(self.journal.name.encode()).hexdigest()[:32]
        self.assertEqual((self.live/'hub.conf').read_bytes(),self.new['hub'])
        self.assertEqual((self.live/f'.codex-hold-{tag}-hub.next').read_bytes(),self.old['hub'])
        self.assertEqual((self.live/'target.conf').read_bytes(),self.old['target'])


if __name__=='__main__':unittest.main()
