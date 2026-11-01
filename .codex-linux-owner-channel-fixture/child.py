import importlib.util,pathlib,time
p=pathlib.Path(__file__).with_name('owner-child.py')
s=importlib.util.spec_from_file_location('owner_child',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
owner=m._open_inherited_fd3();owner.assert_bound();owner.checkpoint('worker-watch-created',{'synthetic':True})
time.sleep(10)
