// RSI 工具包客户端模块：在会话面板注入「RSI 改进」审核引导 section。
// Electron 客户端没有通用 host RPC 网关（客户端 Service 目录仅 8 个服务），
// 因此面板保持静态指引；实时数据与批准/拒绝均在对话内经 rsi-* 工具 + .rsi 文件完成。
window.__ModuleLoader__.load({
  id: 'dsh-rsi',
  factory(require) {
    const React = require('react')

    function RsiSection() {
      return React.createElement(
        'div',
        { style: { padding: '10px 12px', fontSize: '12px', lineHeight: '1.7' } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, 'RSI 改进 · Recursive Self-Improvement'),
        React.createElement('div', null, '失败证据自动收集到 <cwd>/.rsi/evidence/（工具报错、agent 错误、负向反馈）。'),
        React.createElement('div', null, '每轮结束（turn/end）若新增失败证据 ≥ 3 条，会在 .rsi/inbox/ 生成反思任务卡。'),
        React.createElement('div', null, '未消化反思卡 ≥ 3 张时，再生成一份巡检摘要 digest-<ts>.md（来源/工具排名/待审提案）。'),
        React.createElement('div', null, '审核流程（在对话中对 agent 说或直接调用工具）：'),
        React.createElement(
          'ul',
          { style: { margin: '4px 0', paddingLeft: '18px' } },
          React.createElement('li', null, 'rsi-evidence — 查看自动收集的失败证据'),
          React.createElement('li', null, 'rsi-run — 查看实验/变体/probe 产出与补跑指令'),
          React.createElement('li', null, 'rsi-propose — 基于证据起草 harness 改进提案'),
          React.createElement('li', null, 'rsi-review — 列出提案并 approve/reject（提案库 .rsi/proposals/index.json）'),
          React.createElement('li', null, 'rsi-adopt — 经你确认后采纳改动（自动备份 + 记录教训 + 标记 applied）'),
          React.createElement('li', null, 'rsi-lesson — 追加/查看教训库 harness-lessons.md'),
        ),
        React.createElement('div', { style: { marginTop: '6px', opacity: 0.75 } }, 'English: runs, failure evidence and reflection/digest cards are tracked under <cwd>/.rsi; review and adoption happen in conversation via rsi-run / rsi-evidence / rsi-propose / rsi-review / rsi-adopt / rsi-lesson.'),
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
