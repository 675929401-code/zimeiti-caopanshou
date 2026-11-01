import json,os,selectors,signal,subprocess,threading,time

class SQLiteWindowError(RuntimeError): pass

def _fail(code): raise SQLiteWindowError(code) from None

def _kill_group(child):
    try: os.killpg(child.pid,signal.SIGKILL)
    except OSError: pass
    for pipe in (child.stdin,child.stdout):
        if pipe is not None:
            try: pipe.close()
            except OSError: pass
    try: child.wait(timeout=.2)
    except subprocess.TimeoutExpired:
        # Never block the window on an uninterruptible child. The daemon reaper
        # owns only the child created here and does not authorize continuation.
        threading.Thread(target=child.wait,daemon=True).start()
    except OSError: pass

def _bounded_output(child,deadline):
    output=bytearray()
    selector=selectors.DefaultSelector()
    try:
        selector.register(child.stdout,selectors.EVENT_READ)
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0: _fail('SQLITE_CHILD_TIMEOUT')
            ready=selector.select(remaining)
            if not ready: _fail('SQLITE_CHILD_TIMEOUT')
            chunk=os.read(child.stdout.fileno(),4096)
            if not chunk: break
            output.extend(chunk)
            if len(output)>16384: _fail('SQLITE_CHILD_OUTPUT_LIMIT')
        remaining=deadline-time.monotonic()
        if remaining<=0: _fail('SQLITE_CHILD_TIMEOUT')
        child.wait(timeout=remaining)
        return bytes(output)
    finally:
        selector.close()

def _run_clean(python,helper,probe,directory,timeout):
    # Child owns its own process group; close all non-stdio FDs, and neither
    # Python nor its forked readonly reader inherit the watcher's sockets.
    child=None;completed=False;deadline=time.monotonic()+timeout
    try:
        raw=json.dumps({'probe':probe,'directory':str(directory)},separators=(',',':')).encode('ascii')
        if len(raw)>4096: _fail('SQLITE_CHILD_INPUT_LIMIT')
        child=subprocess.Popen([python,'-I','-S','-B',helper,'--child'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},cwd='/')
        child.stdin.write(raw);child.stdin.close();child.stdin=None
        stdout=_bounded_output(child,deadline)
        completed=True
        if child.returncode!=0: _fail('SQLITE_CHILD_FAILED')
        return json.loads(stdout)
    except BaseException:
        if child is not None and not completed:
            try: _kill_group(child)
            except BaseException: pass
        _fail('SQLITE_CHILD_FAILED')
    finally:
        if child is not None:
            for pipe in (child.stdin,child.stdout):
                if pipe is not None:
                    try: pipe.close()
                    except OSError: pass
