import io
import sys

sys.stdout.reconfigure(encoding='utf-8')

P = 'D:/WebProjects/XDstock/public/app.js'
s = io.open(P, encoding='utf-8').read().replace('\r\n', '\n')

old = """    if (panel && !panel.classList.contains('hidden')) renderIndexWeights();
    return;"""

new = """    if (panel && !panel.classList.contains('hidden')) {
      const list = idx.weights || [];
      if (!list.length) {
        panel.innerHTML = '<div class="field-hint">还没有权重数据，下一轮生成</div>';
      } else {
        panel.innerHTML = `
          <div class="rp-head">
            <span class="rp-ind">成分权重</span>
            <span class="rp-period">共 ${list.length} 只</span>
            <span class="rp-cap">季度调仓 · 期内权重冻结</span>
          </div>
          <div class="iw-list">
            ${list.map((w) => `
              <div class="iw-row">
                <span class="iw-name">${escapeHtml(w.name)}</span>
                <span class="iw-bar"><i style="width:${(w.weight * 100).toFixed(1)}%"></i></span>
                <span class="iw-pct">${(w.weight * 100).toFixed(2)}%</span>
                <span class="iw-cap">${fmtMoney(w.freeCap || 0)}</span>
              </div>`).join('')}
          </div>`;
      }
    }
    return;"""

assert old in s, '指数分支未命中'
s = s.replace(old, new, 1)
io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('指数权重改为内联渲染')
