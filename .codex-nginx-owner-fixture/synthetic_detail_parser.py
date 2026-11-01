def fail(code):
    raise ValueError(code)

def nginx_tokens(text):
    if len(text)>1048576:fail('E_LIMIT')
    out=[];word=[];i=0
    def flush():
        if word:out.append(('word',''.join(word)));word.clear()
    while i<len(text):
        c=text[i]
        if c=='\x00':fail('E_LEX')
        if c.isspace():flush();i+=1;continue
        if c=='#':flush();j=text.find('\n',i);i=len(text) if j<0 else j+1;continue
        if c in '{};':flush();out.append((c,c));i+=1;continue
        if c in '\"\'':
            quote=c;i+=1;word.append('')
            while i<len(text) and text[i]!=quote:
                if text[i]=='\\':
                    i+=1
                    if i==len(text):fail('E_LEX')
                word.append(text[i]);i+=1
            if i==len(text):fail('E_LEX')
            i+=1;continue
        if c=='\\':
            i+=1
            if i==len(text):fail('E_LEX')
            word.append(text[i]);i+=1;continue
        if text.startswith('${',i):
            end=text.find('}',i+2)
            if end<0:fail('E_LEX')
            word.append(text[i:end+1]);i=end+1;continue
        word.append(c);i+=1
        if len(out)>100000:fail('E_LIMIT')
    flush();return out

def nginx_parse(text):
    tokens=nginx_tokens(text);index=0
    def parse(block=False,depth=0):
        nonlocal index
        if depth>32:fail('E_LIMIT')
        result=[];words=[]
        while index<len(tokens):
            kind,value=tokens[index];index+=1
            if kind=='word':words.append(value);continue
            if kind=='}':
                if words or not block:fail('E_PARSE')
                return result
            if not words:fail('E_PARSE')
            if kind==';':result.append((words[0],words[1:],None));words=[]
            elif kind=='{':result.append((words[0],words[1:],parse(True,depth+1)));words=[]
        if words or block:fail('E_PARSE')
        return result
    return parse()

