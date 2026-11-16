import sys,email,re,html
from email import policy
for p in sys.argv[1:]:
    m=email.message_from_binary_file(open(p,'rb'),policy=policy.default)
    for part in m.walk():
        if part.get_content_type()=='text/html':
            h=part.get_payload(decode=True).decode("utf-8","replace")
            h=re.sub(r'(?is)<(script|style).*?</\1>','',h)
            h=re.sub(r'(?i)<br\s*/?>|</(p|div|tr|li|h\d)>','\n',h)
            h=re.sub(r'(?i)</t[dh]>',' | ',h)
            t=html.unescape(re.sub(r'<[^>]+>','',h))
            t=re.sub(r'[ \t\xa0]+',' ',t); t=re.sub(r'\n\s*\n+','\n',t)
            print('=====',p.split('/')[-2]); print(t.strip()); break
