import io
import sys

sys.stdout.reconfigure(encoding='utf-8')

P = 'D:/WebProjects/XDstock/server.js'
s = io.open(P, encoding='utf-8').read().replace('\r\n', '\n')

old = """  const me = forPlayerId && d.players[forPlayerId] ? d.players[forPlayerId] : null;
  const activity = activityPayload(d, me);"""
new = """  const tickPlayer = forPlayerId && d.players[forPlayerId] ? d.players[forPlayerId] : null;
  const activity = activityPayload(d, tickPlayer);"""

assert old in s, '未命中'
s = s.replace(old, new, 1)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('变量名冲突已修')
