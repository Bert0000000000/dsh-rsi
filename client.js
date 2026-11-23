// RSI 工具包客户端模块：在会话面板注入「RSI 改进」审核引导 section。
// Electron 客户端没有通用 host RPC 网关（客户端 Service 目录仅 8 个服务），
// 因此面板保持静态指引；实时数据与批准/拒绝均在对话内经 rsi-* 工具 + .rsi 文件完成。
window.__ModuleLoader__.load({
  id: 'dsh-rsi',
  factory(require) {
    const React = require('react')

    function RsiSection() {
      const line = (text, props) => React.createElement('div', props ?? null, text)
      const item = (text) => React.createElement('li', { key: text }, text)
      return React.createElement(
        'div',
        { style: { padding: '10px 12px', fontSize: '12px', lineHeight: '1.7' } },
        line('RSI 改进 · Recursive Self-Improvement', { style: { fontWeight: 600, marginBottom: '6px' } }),
        line('失败证据自动收集到 <cwd>/.rsi/evidence/（工具报错、agent 错误、负向反馈），落盘前脱敏密钥。'),
        line('每轮结束（turn/end）若新增失败证据 ≥ 3 条，会在 .rsi/inbox/ 生成反思任务卡；未消化卡 ≥ 3 张再生成巡检摘要 digest-<ts>.md。'),
        line('实验支持重复采样（repeats）与预算（budget）：probes/<变体>/r<k>/ 逐次产出，collect 按均值 + passRate 判定。'),
        line('审核流程（在对话中对 agent 说或直接调用工具）：'),
        React.createElement(
          'ul',
          { style: { margin: '4px 0', paddingLeft: '18px' } },
          [
            'rsi-plan — 建实验（variants/repeats/mode/budget/rubric，可选 edits 按 8 组件合成）',
            'rsi-run — 查看实验/变体/第 k 次产出与补跑指令',
            'rsi-collect — 逐次评分 + 聚合判定（rubric 哈希校验，任一机器项失败即未通过）',
            'rsi-compare — 同实验两变体的产出 diff，可回写裁判结论',
            'rsi-audit — 检查 probe 是否越界写了 .rsi 之外的文件',
            'rsi-archive — 归档/恢复实验，保留 parent→children 血缘',
            'rsi-propose — 基于证据起草提案',
            'rsi-review — 列提案并 approve/reject（.rsi/proposals/index.json）',
            'rsi-adopt — 仅采纳已 approve 的提案：备份 → 写入 → 冒烟（可选 smoke 命令）→ 记录教训 → 标 applied，失败自动回滚',
            'rsi-lesson — 追加/查看教训库 harness-lessons.md',
          ].map(item),
        ),
        line('评分表在 rsi-plan 时记录 sha256，rsi-collect 比对后才计分；正则评分项有长度/超时/嵌套量词防护。'),
        line('English: runs, failure evidence and reflection/digest cards live under <cwd>/.rsi; review and adoption happen in conversation via the rsi-* tools.', { style: { marginTop: '6px', opacity: 0.75 } }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.panel.section', () =>
          ctx.slots.register({ id: 'rsi-review', order: 50, label: 'RSI 改进' }, RsiSection)
        )
      },
    }
  },
})
